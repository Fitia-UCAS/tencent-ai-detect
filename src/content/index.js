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

    // A blocked press must say why. Leaving the button silent is indistinguishable from the button
    // being broken, which is the same defect the ticker-style notices had: the state is right and the
    // person pressing cannot tell. Drawn with inline styles because this has to render over the site's
    // own CSS and there is no stylesheet of our own on this page.
    const NOTICE_ID = 'zq-press-notice';
    let noticeTimer = null;

    function showPressNotice(text) {
        try {
            const host = document.body || document.documentElement;
            if (!host) return;

            let notice = document.getElementById(NOTICE_ID);
            if (!notice) {
                notice = document.createElement('div');
                notice.id = NOTICE_ID;
                notice.style.cssText = [
                    'position:fixed', 'left:50%', 'transform:translateX(-50%)', 'bottom:88px',
                    'z-index:2147483647', 'max-width:min(520px,86vw)', 'padding:10px 16px',
                    'border-radius:10px', 'background:rgba(31,36,48,.96)', 'color:#e8eaed',
                    'font:13px/1.55 system-ui,sans-serif', 'text-align:center',
                    'box-shadow:0 6px 22px rgba(0,0,0,.38)', 'pointer-events:none'
                ].join(';');
                host.appendChild(notice);
            }

            notice.textContent = text;
            notice.hidden = false;

            if (noticeTimer) clearTimeout(noticeTimer);
            noticeTimer = setTimeout(() => {
                try {
                    if (notice) notice.hidden = true;
                } catch (e) {
                    // The page may have replaced the node; nothing to restore in that case.
                }
            }, 3200);
        } catch (e) {
            // A courtesy notice must never be able to break the press it explains.
        }
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

            // A press on a spent address cannot be served, whichever signal said so: the handshake
            // count or the page's own quota wording. Asking both is what keeps this guard aligned
            // with the watchdog, which has always used addressSpent().
            const spent = typeof ZQ.addressSpent === 'function' ? ZQ.addressSpent() : ZQ.identitySpent();
            if (spent) {
                const mode = ZQ.readSpentMode();

                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();

                ZQ.trace('press-blocked', {
                    reason: 'address-exhausted',
                    uses: ZQ.identityUses(),
                    mode,
                    state: ZQ.pageState()
                });

                // 'press' means exactly this moment: the click that cannot be served is the request
                // for a new address. 'delay' owns the wait, including the zero wait that swaps at
                // once. 'manual' leaves it to the panel button. None of them may send a request the
                // spent address cannot serve.
                if (mode === 'press') {
                    ZQ.forceRotate('address-exhausted');
                } else if (mode === 'delay' && typeof ZQ.onAddressSpent === 'function') {
                    ZQ.onAddressSpent('press');
                } else {
                    ZQ.reportSpentOnce();
                }

                return;
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

            // A short no-challenge ticket is passed on to the server rather than withheld. If the
            // page still shows its refusal, allow one user press to request a fresh ticket instead
            // of treating that old result as a new stale refusal. Consume the marker once;
            // address-spent and identity-unconfirmed guards above still take precedence.
            const quickPass = ZQ.state.quickPass;
            if (quickPass) {
                ZQ.state.quickPass = null;
                ZQ.trace('quick-pass-retry', {
                    ticketLength: quickPass.ticketLength,
                    state: ZQ.pageState()
                });
            }

            // The page is still showing a refusal from an earlier attempt.
            //
            // Pressing again on that screen sends a request from a session the site has already
            // refused, and a run of those is the clearest signal a rate limiter has: the trail shows
            // presses at 20s and 45s on an unchanged "Invalid request" panel, each one costing a
            // handshake and returning the same word. The press is stopped and the page is offered a
            // fresh start instead, which is the one action that can change the outcome.
            //
            // A press while the page is asking for a challenge cannot produce a usable ticket.
            //
            // The ticket the page holds is what the server judges, and only a solved challenge makes
            // it usable. So a press made while the site is waiting on a challenge, or has just refused
            // one, spends a handshake and comes back with `code 21 "diff"` - which the page renders as
            // "Invalid request". Measured across the whole trail: of 10 presses made while the page
            // said `captcha`, 8 were answered `code 21` and 1 produced no ticket at all.
            //
            // The condition is the state word alone, and that is the correction this guard needed. It
            // used to also require the widget to be inside the viewport, and that requirement was the
            // defect: the site hides the challenge by parking it at a negative offset, and it does so
            // again while swapping in a replacement after a failed attempt - so exactly when a
            // challenge was live and being redrawn, the geometry said "no challenge" and the press
            // went through. Measured: page state `captcha` at 13:47:41.352, press at 13:47:42.270,
            // challenge node at y -9999 mid-swap, and the press was allowed.
            //
            // `captchaOpen()` is still recorded on the trail, because geometry is what explains the
            // swap; it is just not what decides this.
            const state = ZQ.pageState();

            if (state === 'captcha') {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();

                ZQ.trace('press-blocked', {
                    reason: 'challenge-pending',
                    state,
                    challengeOpen: ZQ.captchaOpen(),
                    uses: ZQ.identityUses()
                });

                ZQ.state.challengeBlockedAt = Date.now();
                showPressNotice(
                    '请先完成人机验证再检测；若验证码正在刷新，稍等一两秒它就回来。');
                return;
            }

            if (state === 'ambiguous' && !quickPass) {
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
                if (request.action === 'getStatus') {
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

    // The three spent-address modes are the whole policy. There is no hidden refresh switch: the
    // automatic detect click that used to read one is gone, and the rotation these settings drive
    // must keep working without it.
    function readSettings() {
        try {
            chrome.storage.local.get(['spentMode', 'spentDelaySeconds'], stored => {
                const spent = ZQ.resolveSpentSettings(stored);
                ZQ.state.spentMode = spent.spentMode;
                ZQ.state.spentDelaySeconds = spent.spentDelaySeconds;
            });

            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== 'local') return;

                // Resolve both fields together. A storage change can deliver the mode and wait in one
                // callback; resolving them separately lets a legacy 'immediate' mode lose its required
                // zero wait when the same event also carries a stale delay value.
                if (changes.spentMode || changes.spentDelaySeconds) {
                    const spent = ZQ.resolveSpentSettings({
                        spentMode: changes.spentMode
                            ? changes.spentMode.newValue
                            : ZQ.state.spentMode,
                        spentDelaySeconds: changes.spentDelaySeconds
                            ? changes.spentDelaySeconds.newValue
                            : ZQ.state.spentDelaySeconds
                    });
                    ZQ.state.spentMode = spent.spentMode;
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
