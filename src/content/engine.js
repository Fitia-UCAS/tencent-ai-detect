// The rotation engine: decide whether to rotate, and do it in a fixed order.
//
// One rotation is a short sequence — confirm the relay is up, record the attempt, drop the
// fingerprint, tell the background, then schedule the reload that opens a fresh socket. Anything
// that cannot be done is reported and the sequence stops, rather than half-completing.

(function () {
    'use strict';

    if (window.__zqDetectReady) return;

    const ZQ = (window.__zq = window.__zq || {});

    // The worker answers in milliseconds when alive. Waiting forever would leave rotating=true,
    // and every later attempt would bail out with the page stuck mid-detect.
    ZQ.RELAY_PROBE_TIMEOUT_MS = 3000;

    // The probe runs in the worker because a content-script fetch is treated as a page request and
    // blocked by CORS in MV3.
    ZQ.relayReady = function () {
        return new Promise(resolve => {
            if (!ZQ.state.contextAlive) {
                resolve(false);
                return;
            }

            let settled = false;
            let timeout = null;

            // Every path settles exactly once and always clears the timer.
            const finish = ok => {
                if (settled) return;
                settled = true;
                if (timeout) clearTimeout(timeout);
                resolve(ok);
            };

            timeout = setTimeout(() => finish(false), ZQ.RELAY_PROBE_TIMEOUT_MS);

            try {
                const pending = chrome.runtime.sendMessage({ action: 'relayHealth' }, response => {
                    try {
                        if (chrome.runtime.lastError) {
                            finish(false);
                            return;
                        }
                    } catch (error) {
                        // Reading lastError on a dead context throws as well.
                        ZQ.noteContextError(error);
                        finish(false);
                        return;
                    }

                    finish(!!(response && response.ok));
                });

                // Some builds return a Promise here, and it rejects if the context dies first.
                if (pending && typeof pending.catch === 'function') {
                    pending.catch(error => {
                        ZQ.noteContextError(error);
                        finish(false);
                    });
                }
            } catch (error) {
                ZQ.noteContextError(error);
                finish(false);
            }
        });
    };

    // A stale script must not schedule new reloads after its context was invalidated.
    //
    // The user's challenge comes first: a reload here would throw their work away mid-captcha, so an
    // open challenge postpones it instead. Re-checking keeps this from being a one-shot miss - the
    // reload happens on its own once the challenge is gone.
    ZQ.CAPTCHA_WAIT_MS = 2000;

    ZQ.scheduleRetry = function (delayMs) {
        if (!ZQ.state.contextAlive) return;
        if (ZQ.state.retryTimer) clearTimeout(ZQ.state.retryTimer);

        ZQ.writeState({ backoffUntil: Date.now() + delayMs });

        ZQ.state.retryTimer = setTimeout(() => {
            if (!ZQ.state.contextAlive || !ZQ.state.autoRefresh) return;

            if (ZQ.captchaOpen()) {
                ZQ.scheduleRetry(ZQ.CAPTCHA_WAIT_MS);
                return;
            }

            location.reload();
        }, delayMs);
    };

    ZQ.currentState = function (status) {
        const state = ZQ.readState();
        const quota = ZQ.readQuota();

        return {
            at: Date.now(),
            status: status || 'idle',
            rotations: state.rotations,
            failures: state.failures,
            cooldownUntil: state.backoffUntil,
            ip: state.ip,
            transport: state.transport || null,
            signedIn: ZQ.signedIn(),
            // What the page says is left, so the panel can show the number instead of only
            // "ready" and leave the user to open the page and look.
            remaining: quota.remaining
        };
    };

    ZQ.reportState = function (state) {
        ZQ.send({ action: 'statusUpdate', payload: state });
    };

    ZQ.rotate = async function (reason) {
        if (!ZQ.state.enabled || ZQ.state.rotating) return;

        // A challenge on screen means the page is waiting on the user, not on a new address.
        // Rotating now would reload mid-challenge and discard their work.
        if (ZQ.captchaOpen()) {
            ZQ.scheduleRetry(ZQ.CAPTCHA_WAIT_MS);
            return;
        }

        const state = ZQ.readState();

        if (Date.now() < state.backoffUntil) {
            ZQ.scheduleRetry(state.backoffUntil - Date.now());
            return;
        }

        if (ZQ.signedIn()) {
            ZQ.reportState(ZQ.currentState('signed-in'));
            return;
        }

        const gap = Date.now() - state.lastRotationAt;

        if (gap < ZQ.MIN_GAP_MS) {
            ZQ.scheduleRetry(ZQ.MIN_GAP_MS - gap);
            return;
        }

        ZQ.state.rotating = true;

        // The relay is the only transport: without it there is no way to change the client
        // address, and the only other API that can is the debugger, which would put Chromium's
        // debug bar back on screen. The page is left alone instead.
        const viaRelay = await ZQ.relayReady();

        if (!viaRelay) {
            ZQ.state.rotating = false;
            ZQ.reportState(ZQ.currentState('relay-offline'));
            return;
        }

        ZQ.writeState({
            rotations: state.rotations + 1,
            failures: 0,
            lastRotationAt: Date.now(),
            ip: 'relay',
            transport: 'relay'
        });

        ZQ.clearFp();
        ZQ.send({ action: 'logReset', ip: 'relay', reason: reason });

        ZQ.state.rotating = false;

        ZQ.reportState(ZQ.currentState('rotated'));

        // The reload opens a fresh socket. The reloaded page runs identity.js again, which mints a
        // new address, so the reload - not the relay - is what rotates the identity.
        ZQ.scheduleRetry(1200);
    };

    // Only a genuine quota hit justifies a reload. A captcha failure belongs to the user, and an
    // ambiguous refusal is reported without acting.
    ZQ.handlePageState = function (reason) {
        const state = ZQ.pageState();

        if (state === 'quota') {
            ZQ.rotate(reason);
            return;
        }

        if (state !== 'ok') {
            ZQ.reportState(ZQ.currentState(state));
        }
    };

    // A page that already shows an exhausted allowance and then sits still produces no DOM change
    // and no click, so neither existing trigger fires — the common case, because the user opens the
    // page after the allowance is spent. This asks on a timer instead of waiting to be told.
    //
    // rotate() refuses while a rotation is in flight and inside its cooldown, so a tick during a
    // pending reload cannot stack another one.
    ZQ.WATCHDOG_MS = 5000;

    // Returns a function that stops the watchdog, so a dead context can be shut down explicitly.
    // The active stop function is also kept on the namespace, which lets callers that never saw
    // the return value (a test sandbox, an unloading page) tear the timer down.
    ZQ.startWatchdog = function (intervalMs) {
        const every = intervalMs || ZQ.WATCHDOG_MS;
        let timer = null;

        const stop = () => {
            if (timer) clearInterval(timer);
            timer = null;
            if (ZQ._stopWatchdog === stop) ZQ._stopWatchdog = null;
        };

        const tick = () => {
            // A reloading extension leaves this script running with every chrome.* call throwing;
            // it must stop asking rather than keep scheduling reloads.
            if (!ZQ.state.contextAlive) {
                stop();
                return;
            }

            if (!ZQ.state.enabled || !ZQ.state.autoRefresh || ZQ.state.rotating) return;

            // The address limit is checked here, not only after a click. Detecting the detect button
            // by its text is best-effort - a variant that does not say "检测" and whose class carries
            // neither "detect" nor "check" leaves the count rising with nothing watching it. The fifth
            // handshake is then refused and the page shows "Invalid request", which no rotation can
            // undo because that address is already spent. Reading the stored count makes the trigger
            // exact no matter how the detection was started.
            if (ZQ.identityUses() >= ZQ.USES_PER_IDENTITY) {
                ZQ.rotate('identity-exhausted');
                return;
            }

            if (ZQ.pageState() !== 'quota') return;

            ZQ.handlePageState('watchdog');
        };

        // Replacing a running watchdog must not leave the previous timer behind.
        if (typeof ZQ._stopWatchdog === 'function') ZQ._stopWatchdog();

        timer = setInterval(tick, every);
        ZQ._stopWatchdog = stop;
        return stop;
    };

    ZQ.stopWatchdog = function () {
        if (typeof ZQ._stopWatchdog === 'function') ZQ._stopWatchdog();
    };
})();
