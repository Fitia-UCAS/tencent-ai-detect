// Shared runtime for the content script: state, context guard, messaging.
//
// Content scripts cannot use ES modules without a bundler, so the content layer is four classic
// scripts loaded in order by the manifest. They share one namespace object, which makes the
// coupling explicit instead of scattering it across file-scope variables.
//
// Load order: core -> detection -> engine -> index.

(function () {
    'use strict';

    if (window.__zqDetectReady) return;

    const ZQ = (window.__zq = window.__zq || {});

    // Storage and pacing constants.
    ZQ.FP_KEYS = ['fp', 'fingerprint', 'device_fp'];
    // The rotation log lives in localStorage: the site clears sessionStorage on load, which would
    // otherwise reset the counters on every reload the rotation itself triggers.
    ZQ.STATE_KEY = 'zqRotationState';
    // The server throttles bursts per client address; rotations are paced to stay civil.
    ZQ.MIN_GAP_MS = 2500;

    ZQ.state = {
        enabled: true,
        autoRefresh: true,
        // 'manual' | 'press' | 'delay'. The panel owns this; see ZQ.readSpentMode.
        spentMode: 'manual',
        // Only used by 'delay'. Seconds, because that is what the panel shows. Zero is a legal value
        // and means "swap as soon as the allowance is gone"; the panel says what that costs.
        spentDelaySeconds: 2,
        rotating: false,
        retryTimer: null,
        contextAlive: true,
        // Navigation timing origin for this document, in ms. The gap between a page becoming ready and
        // the press is a real variable: the one successful run on record pressed 6167ms after load,
        // and pressing earlier may spend the handshake on a page whose own client is still starting.
        loadedAt: (function () {
            try {
                if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
                    return Date.now() - performance.now();
                }
            } catch (e) {
                // Fall through: a missing performance object just means the clock starts now.
            }

            return Date.now();
        })()
    };

    // The four questions every action in this layer asks, answered here and nowhere else.
    //
    // Each answer is derived from the same three flags, so a decision taken at one place cannot
    // disagree with the same decision taken at another. Spelling the combinations out per site is
    // what let the mutation observers act on a page whose reload switch was off.
    ZQ.isAlive = () => ZQ.state.contextAlive;
    ZQ.isEnabled = () => ZQ.isAlive() && ZQ.state.enabled;
    ZQ.canAutoAct = () => ZQ.isEnabled() && ZQ.state.autoRefresh;
    ZQ.canRotate = () => ZQ.canAutoAct() && !ZQ.state.rotating;

    // How long this document has existed, measured from its own navigation start. Distinct from
    // "since the extension started": a content script can be injected into a tab that has been open
    // for minutes, which is the case where the page is old and the script is new.
    ZQ.pageAge = function pageAge() {
        try {
            if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
                return Math.round(performance.now());
            }
        } catch (e) {
            // Fall through to the wall clock.
        }

        return Date.now() - ZQ.state.loadedAt;
    };

    function isInvalidated(error) {
        return String((error && error.message) || error || '').includes('Extension context invalidated');
    }

    // Repairing a stale context.
    //
    // Reloading the extension leaves this script running in every tab that was already open, where
    // every chrome.* call throws. The old behaviour was to go quiet, which is why the symptom is
    // "the extension stopped working and said nothing".
    //
    // Page-level abilities survive a stale context: localStorage still reads and writes, the DOM is
    // still writable, and location.reload() still reloads. So the failure can be shown and repaired
    // from here, and a refresh is enough - the tab does not have to be closed, because the reload
    // injects a fresh copy of the scripts.
    const STALE_NOTICE_ID = 'zq-context-stale';
    // One automatic reload per window. Without it, a page that cannot re-inject for some other
    // reason would reload itself forever, which is worse than the failure it is trying to fix.
    const STALE_RELOAD_KEY = 'zqContextReloadAt';
    const STALE_RELOAD_GAP_MS = 20000;
    // Long enough for the notice to be read before the page goes away.
    const STALE_RELOAD_DELAY_MS = 1500;

    function showStaleNotice(text) {
        try {
            const host = document.body || document.documentElement;
            if (!host) return;

            const existing = document.getElementById(STALE_NOTICE_ID);
            if (existing) {
                existing.textContent = text;
                return;
            }

            const notice = document.createElement('div');
            notice.id = STALE_NOTICE_ID;
            notice.textContent = text;
            // Inline styles: this has to render after the extension is gone, so there is nothing to
            // load a stylesheet from and no class the site is known to keep.
            notice.style.cssText = [
                'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
                'max-width:320px', 'padding:10px 14px', 'border-radius:8px',
                'background:#1f2430', 'color:#e8eaed', 'font:13px/1.5 system-ui,sans-serif',
                'box-shadow:0 4px 16px rgba(0,0,0,.35)'
            ].join(';');

            host.appendChild(notice);
        } catch (e) {
            // The notice is a courtesy; failing to draw it must not stop the repair below.
        }
    }

    // Returns false when the guard refuses, so the caller can leave the notice standing instead of
    // promising a reload that will not happen.
    function reloadOnceForStaleContext() {
        try {
            const last = Number(localStorage.getItem(STALE_RELOAD_KEY)) || 0;
            if (Date.now() - last < STALE_RELOAD_GAP_MS) return false;
            localStorage.setItem(STALE_RELOAD_KEY, String(Date.now()));
        } catch (e) {
            // Storage blocked means the guard cannot be trusted, and an unbounded reload loop is
            // worse than asking the user to refresh by hand.
            return false;
        }

        try {
            location.reload();
        } catch (e) {
            return false;
        }

        return true;
    }

    ZQ.recoverFromStaleContext = function recoverFromStaleContext() {
        // The draft survives the reload through the same path a rotation uses, so an automatic
        // refresh does not cost the text the user pasted.
        const kept = typeof ZQ.saveDraft === 'function' ? ZQ.saveDraft() : false;

        showStaleNotice(kept
            ? 'Extension was reloaded. Refreshing this page to reconnect, your text is kept.'
            : 'Extension was reloaded. Refreshing this page to reconnect.');

        setTimeout(() => {
            if (reloadOnceForStaleContext()) return;
            showStaleNotice('Extension was reloaded. Refresh this page manually to reconnect.');
        }, STALE_RELOAD_DELAY_MS);
    };

    // Reloading the extension leaves this script running in open tabs, where every chrome.* call
    // throws. It reports once, then repairs.
    ZQ.noteContextError = function noteContextError(error) {
        if (!isInvalidated(error)) return;

        // Every later chrome.* call reports the same thing, and a repair is already under way.
        if (!ZQ.isAlive()) return;

        ZQ.state.contextAlive = false;

        // A reload already scheduled would still fire, throwing the user out of a page for no
        // benefit: the replacement script only arrives after that reload.
        if (ZQ.state.retryTimer) {
            clearTimeout(ZQ.state.retryTimer);
            ZQ.state.retryTimer = null;
            ZQ.writeState({ backoffUntil: 0 });
        }

        ZQ.recoverFromStaleContext();
    };

    // Sends a message and never throws: resolves null once the context is gone.
    ZQ.send = function send(message) {
        if (!ZQ.isAlive()) return Promise.resolve(null);

        try {
            return Promise.resolve(chrome.runtime.sendMessage(message)).catch(error => {
                ZQ.noteContextError(error);
                return null;
            });
        } catch (error) {
            ZQ.noteContextError(error);
            return Promise.resolve(null);
        }
    };

    // Records one step of this load for later reading.
    //
    // The steps of a detection are not a fixed sequence: the challenge comes up for some presses and
    // not others, the result arrives sooner or later depending on the queue, and the address rule may
    // never install at all. Every guard in this codebase asks "is X true now", which cannot tell a
    // step that has not happened from one that already passed. This records what did happen and when,
    // so a wrong turn is read off the trail instead of inferred from the page's wording.
    //
    // `withPage` attaches a structured picture of the page at that instant. The trail alone says what
    // this extension did; the picture says what it was looking at, which is the difference between a
    // refusal and a stale view of an older one.
    ZQ.trace = function trace(name, detail, withPage) {
        try {
            let page = null;
            if (withPage && typeof ZQ.snapshot === 'function') {
                page = ZQ.snapshot(name);
            }

            ZQ.send({
                action: 'trace',
                payload: {
                    name: String(name),
                    detail: detail === undefined ? null : detail,
                    page
                }
            });
        } catch (e) {
            // Tracing must never be able to break the page it is describing.
        }
    };
})();
