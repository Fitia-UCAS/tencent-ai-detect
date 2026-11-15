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
    // The listener is registered in the capture phase, and that is what makes the spent check work.
    // It used to run in the bubble phase and only look at the count 2500ms later, by which time the
    // page had already opened the fifth socket on a spent address and the server had refused it -
    // the "Invalid request" the user saw. Capturing means the press is stopped before the page's own
    // handler runs, so the refused handshake is never sent at all.
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
                // for a new address. 'manual' leaves it to the panel button. Both stop the press.
                if (mode !== 'immediate') {
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();

                    ZQ.trace('press-blocked', { reason: 'identity-exhausted', uses: ZQ.identityUses(), mode });

                    if (mode === 'press') ZQ.forceRotate('identity-exhausted');
                    else ZQ.reportSpentOnce();

                    return;
                }
            }

            // And the rule that makes the ticket and the socket agree has to be in place.
            //
            // Only auto mode used to look at this, so a manual press went out regardless: the
            // captcha ticket was issued for whatever address the header rule injected - the real one,
            // if the rule was never installed - while the socket carried the synthetic one, and the
            // server refused every single time. That refusal is what "Invalid request" is. Stopping
            // the press and saying so is the only honest option while the two addresses disagree.
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
                } else if (request.action === 'autoRefresh') {
                    ZQ.state.autoRefresh = request.enabled;
                    sendResponse({ status: 'success' });
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

    // The panel writes autoRefresh to storage; without reading it here the switch would flip in
    // the UI while this script kept reloading anyway.
    function readSettings() {
        try {
            chrome.storage.local.get(['autoRefresh', 'spentMode', 'spentDelaySeconds'], stored => {
                ZQ.state.autoRefresh = stored.autoRefresh !== false;
                ZQ.state.spentMode = stored.spentMode || 'manual';

                // Kept as seconds; the engine converts. Storing the raw value means a later change to
                // the default does not silently move a number the user chose.
                const seconds = Number(stored.spentDelaySeconds);
                ZQ.state.spentDelaySeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 30;
            });

            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== 'local') return;

                // The spent-mode choice takes effect without a reload: the panel is where it is set,
                // and a setting that only applies to the next page would look broken.
                if (changes.spentMode) {
                    ZQ.state.spentMode = changes.spentMode.newValue || 'manual';
                }

                if (changes.spentDelaySeconds) {
                    const seconds = Number(changes.spentDelaySeconds.newValue);
                    ZQ.state.spentDelaySeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : 30;
                }

                if (!changes.autoRefresh) return;

                ZQ.state.autoRefresh = changes.autoRefresh.newValue !== false;

                // Turning it off must also cancel a reload that is already scheduled.
                if (!ZQ.state.autoRefresh && ZQ.state.retryTimer) {
                    clearTimeout(ZQ.state.retryTimer);
                    ZQ.state.retryTimer = null;
                    ZQ.writeState({ backoffUntil: 0 });
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
        autoRefresh: ZQ.state.autoRefresh,
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

    // And drive the detection itself: the watchdog only keeps the allowance fresh, which is useless
    // if nothing ever asks for a detection. This is what makes the extension hands-off - paste once
    // and it runs, rotates, restores the text and runs again.
    if (typeof ZQ.startAuto === 'function') ZQ.startAuto();

    // A fresh load runs on whatever address the background already installed; report it so the
    // panel shows the live value instead of a stale one.
    ZQ.reportState(ZQ.currentState(ZQ.signedIn() ? 'signed-in' : 'idle'));

    // Set last: until every listener is registered, a second injection must be allowed to retry.
    window.__zqDetectReady = true;
})();
