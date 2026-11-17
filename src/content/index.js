// Wiring: observe the page, accept settings, and report the starting state.
//
// This file owns every listener and observer, so loading it twice is the only way to duplicate
// them — hence the single guard at the top and the flag set at the very end, after everything
// succeeded.

(function () {
    'use strict';

    if (window.__zqDetectReady) return;

    const ZQ = (window.__zq = window.__zq || {});

    // Diagnostics must never be able to take down the page they are describing. core.js defines
    // ZQ.trace, but this file also runs in environments that load it alone (the document-start test
    // does exactly that), and a missing tracer would throw from the first thing this file does.
    if (typeof ZQ.trace !== 'function') {
        ZQ.trace = function trace() {};
    }

    // The result panel is re-rendered rather than appended, so the subtree is observed instead of
    // polling on a timer.
    function watchResults() {
        const observer = new MutationObserver(() => {
            if (!ZQ.isAlive()) return;

            // Every mutation runs this, and the page mutates constantly while a result renders. Only
            // the transitions are worth keeping: a trail padded with a hundred identical samples
            // hides the one line that explains the failure.
            const state = typeof ZQ.pageState === 'function' ? ZQ.pageState() : null;
            if (state && state !== ZQ.state.lastTracedState) {
                ZQ.state.lastTracedState = state;
                ZQ.trace('page-state', {
                    state,
                    quota: typeof ZQ.readQuota === 'function' ? ZQ.readQuota() : null
                });
            }

            // Acting on what the page shows is the automatic path, and it only exists while this
            // page is allowed to reload itself. Reading the state for the trail still happens above.
            if (!ZQ.canRotate()) return;

            ZQ.handlePageState('quota');
        });

        // document_start can run before the <html> element exists. A Document is a valid
        // MutationObserver target and also observes the root as it is inserted later.
        observer.observe(document, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    // Usage is counted from clicks on the site's own detect controls.
    //
    // The listener is registered in the capture phase, and that is what makes the spent check work:
    // the press is stopped before the page's own handler runs, so a refused handshake is never sent
    // at all. Sampling the count afterwards would let the page open the fifth socket on a spent
    // address first, which the server answers with "Invalid request".
    function monitorUsage() {
        document.addEventListener('click', event => {
            const target = event.target;
            const text = target.textContent || '';
            const rawClassName = target.className;

            // SVGElement.className is an SVGAnimatedString, not a string; normalize before
            // substring checks so clicks on icons do not throw from this document-level listener.
            const className = typeof rawClassName === 'string'
                ? rawClassName
                : rawClassName && typeof rawClassName.baseVal === 'string'
                    ? rawClassName.baseVal
                    : '';

            // The Chinese literals below are the site's own button labels.
            if (!text.includes('检测') && !text.includes('立即检测') &&
                !className.includes('detect') && !className.includes('check')) return;

            // Measured: the server reports five detections per address and then zero, so a sixth press
            // on the same address is refused permanently. The spent address has to be swapped first,
            // and that swap is a reload - so what happens to this press is the user's setting.
            if (ZQ.identitySpent()) {
                const mode = ZQ.readSpentMode();

                // 'press' means exactly this moment: the click that cannot be served is the request
                // for a new address. 'manual' leaves it to the panel button. Both stop the press. A
                // zero wait is the one exception, because the page is about to replace itself anyway.
                if (!ZQ.swapsAtOnce()) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();

                    ZQ.trace('press-blocked', { reason: 'identity-exhausted', uses: ZQ.identityUses(), mode });

                    if (mode === 'press') ZQ.forceRotate('identity-exhausted');
                    else ZQ.reportSpentOnce();

                    return;
                }
            }

            // And the rule that makes the ticket and the socket agree has to be in place before any
            // press, auto or manual.
            //
            // Without it the captcha ticket is issued for whatever address the header rule injected -
            // the real one - while the socket carries the synthetic one, and the server refuses every
            // single time. That refusal is what "Invalid request" is. Stopping the press and saying so
            // is the only honest option while the two addresses disagree.
            if (ZQ.state.identityConfirmed === false) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();

                // A refusal is often transient - the worker restarting, rules being replaced - so the
                // press itself is the natural moment to try publishing again.
                ZQ.trace('press-blocked', { reason: 'identity-unconfirmed' });
                ZQ.publishIdentity(ZQ.currentIdentity());
                ZQ.reportState(ZQ.currentState('identity-unconfirmed'));
                return;
            }

            // The page is still showing a refusal from an earlier attempt.
            //
            // Pressing again on that screen sends a request from a session the site has already
            // refused, and a run of those is the clearest signal a rate limiter has: the trail shows
            // presses at 20s and 45s on an unchanged "Invalid request" panel, each one costing a
            // handshake and returning the same word. The press is stopped and the page is offered a
            // fresh start instead, which is the one action that can change the outcome.
            //
            // Only the ambiguous state is caught here. 'captcha' is left alone: the challenge is the
            // user's to solve and the page handles the press, and a solved challenge sometimes clears
            // without the panel ever going ambiguous.
            if (ZQ.pageState() === 'ambiguous') {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();

                ZQ.trace('press-blocked', { reason: 'stale-refusal', uses: ZQ.identityUses() });
                ZQ.reportState(ZQ.currentState('refusal-pending'));
                return;
            }

            ZQ.trace('press', {
                state: ZQ.pageState(),
                uses: ZQ.identityUses(),
                spent: ZQ.identitySpent(),
                challengeOpen: ZQ.captchaOpen(),
                challengeOpenAt: ZQ.state.challengeOpenAt || 0,
                // How long this document had existed at the moment of the press. The one successful
                // run on record pressed 6167ms after load; pressing earlier may spend the handshake on
                // a page whose own client has not finished starting, which would look like a refusal.
                pageAgeMs: typeof ZQ.pageAge === 'function' ? ZQ.pageAge() : null
            }, true);

            ZQ.send({ action: 'usageIncrement' });

            setTimeout(() => {
                if (!ZQ.isAlive()) return;

                ZQ.trace('press-settle', {
                    state: ZQ.pageState(),
                    challengeOpen: ZQ.captchaOpen(),
                    pageAgeMs: typeof ZQ.pageAge === 'function' ? ZQ.pageAge() : null
                }, true);

                // The settle check exists to decide whether this page should act on what the press
                // produced, which is the automatic path.
                if (!ZQ.canRotate()) return;

                ZQ.handlePageState('quota-after-click');
            }, 2500);
        }, true);
    }

    // Registering listeners also throws on a dead context, so setup is guarded as a whole.
    function registerMessages() {
        try {
            chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
                if (request.action === 'toggle') {
                    ZQ.state.enabled = request.enabled;
                    sendResponse({ status: 'success' });
                } else if (request.action === 'getStatus') {
                    sendResponse(ZQ.currentState(ZQ.pageState()));
                } else if (request.action === 'rotateNow') {
                    // A press that cannot be served is the one case where swapping the address is
                    // what the user asked for, so this bypasses the spent-address hold rather than
                    // leaving them with a page that refuses every click.
                    ZQ.forceRotate('manual');
                    sendResponse({ status: 'success' });
                }

                // Every handled action answers synchronously. Unknown actions never respond, so
                // returning true would leave their message channels open indefinitely.
                return false;
            });
        } catch (error) {
            ZQ.noteContextError(error);
        }
    }

    // Reads the stored answer, whatever shape it was written in.
    //
    // 'immediate' was a separate mode before the wait accepted zero, so a profile that still holds it
    // means "wait zero seconds" - not "fall back to the default", which would silently change what the
    // user chose. Both values are resolved together because the migration decides one of them: reading
    // the mode and the wait separately let a stale stored wait overwrite the zero the migration meant.
    function resolveSpentSettings(stored) {
        const mode = stored && stored.spentMode;
        const seconds = Number(stored && stored.spentDelaySeconds);
        const wait = Number.isFinite(seconds) && seconds >= 0 ? seconds : ZQ.DEFAULT_SPENT_DELAY_SECONDS;

        if (mode === 'immediate') return { spentMode: 'delay', spentDelaySeconds: 0 };

        return {
            spentMode: ZQ.SPENT_MODES.indexOf(mode) !== -1 ? mode : 'manual',
            spentDelaySeconds: wait
        };
    }

    // The three spent-address modes are the whole policy. There is no hidden refresh switch: the
    // automatic detect click that used to read one is gone, and the rotation these settings drive
    // must keep working without it.
    function readSettings() {
        try {
            chrome.storage.local.get(['spentMode', 'spentDelaySeconds'], stored => {
                const spent = resolveSpentSettings(stored);
                ZQ.state.spentMode = spent.spentMode;
                ZQ.state.spentDelaySeconds = spent.spentDelaySeconds;
            });

            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== 'local') return;

                // The spent-mode choice takes effect without a reload: the panel is where it is set,
                // and a setting that only applies to the next page would look broken.
                if (changes.spentMode) {
                    const spent = resolveSpentSettings({
                        spentMode: changes.spentMode.newValue,
                        spentDelaySeconds: ZQ.state.spentDelaySeconds
                    });
                    ZQ.state.spentMode = spent.spentMode;
                }

                if (changes.spentDelaySeconds) {
                    const spent = resolveSpentSettings({
                        spentMode: ZQ.state.spentMode,
                        spentDelaySeconds: changes.spentDelaySeconds.newValue
                    });
                    ZQ.state.spentDelaySeconds = spent.spentDelaySeconds;
                }
            });
        } catch (error) {
            ZQ.noteContextError(error);
        }
    }

    monitorUsage();
    watchResults();
    registerMessages();
    readSettings();

    // Pick this load's identity before anything is sent, and tell the background so it can put the
    // same address on the page's own captcha request. The shim reads it back for the socket.
    const identity = ZQ.ensureIdentity();

    // Read defensively: this runs at document_start, where detection.js has loaded but a page that
    // blocks early script evaluation may leave those readers missing. A trace that throws here would
    // take down the whole load, which is the one thing diagnostics must never do.
    ZQ.trace('load', {
        identity,
        pageState: typeof ZQ.pageState === 'function' ? ZQ.pageState() : null,
        quota: typeof ZQ.readQuota === 'function' ? ZQ.readQuota() : null,
        readyState: (function () {
            try {
                return document.readyState;
            } catch (e) {
                return null;
            }
        })(),
        pageAgeMs: typeof ZQ.pageAge === 'function' ? ZQ.pageAge() : null
    });

    ZQ.publishIdentity(identity);

    // Ask on a timer as well, so a page that is already exhausted and then sits still still
    // rotates without the user clicking anything.
    if (typeof ZQ.startWatchdog === 'function') ZQ.startWatchdog();

    // A fresh load runs on whatever address the background already installed; report it so the
    // panel shows the live value instead of a stale one.
    ZQ.reportState(ZQ.currentState(ZQ.signedIn() ? 'signed-in' : 'idle'));

    // Set last: until every listener is registered, a second injection must be allowed to retry.
    window.__zqDetectReady = true;
})();
