// Wiring: observe the page, accept settings, and report the starting state.
//
// This file owns every listener and observer, so loading it twice is the only way to duplicate
// them — hence the single guard at the top and the flag set at the very end, after everything
// succeeded.

(function () {
    'use strict';

    if (window.__zqDetectReady) return;

    const ZQ = (window.__zq = window.__zq || {});

    // The result panel is re-rendered rather than appended, so the subtree is observed instead of
    // polling on a timer.
    function watchResults() {
        const observer = new MutationObserver(() => {
            if (!ZQ.state.enabled || ZQ.state.rotating) return;
            ZQ.handlePageState('quota');
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    // Usage is counted from clicks on the site's own detect controls.
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

            ZQ.send({ action: 'usageIncrement' });

            setTimeout(() => {
                if (!ZQ.state.enabled || ZQ.state.rotating) return;

                // Measured: an address serves four handshakes and is refused from the fifth onwards.
                // Reloading before that point costs nothing and moves the page onto a fresh address,
                // so the user never meets that refusal. Deciding on the count rather than on the
                // refusal keeps rotate() off an ambiguous message, which once caused a reload loop.
                if (ZQ.identityUses() >= ZQ.USES_PER_IDENTITY) {
                    ZQ.rotate('identity-exhausted');
                    return;
                }

                ZQ.handlePageState('quota-after-click');
            }, 2500);
        });
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
                } else if (request.action === 'manualReset') {
                    ZQ.writeState({ failures: 0, backoffUntil: 0, lastRotationAt: 0 });

                    if (ZQ.state.retryTimer) clearTimeout(ZQ.state.retryTimer);
                    ZQ.state.retryTimer = null;

                    ZQ.state.rotating = false;
                    ZQ.rotate('manual');
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
            chrome.storage.local.get(['autoRefresh'], stored => {
                ZQ.state.autoRefresh = stored.autoRefresh !== false;
            });

            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== 'local' || !changes.autoRefresh) return;

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
    ZQ.publishIdentity(ZQ.ensureIdentity());

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
