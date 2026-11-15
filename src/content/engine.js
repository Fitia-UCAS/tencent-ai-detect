// The rotation engine: decide whether to rotate, and do it in a fixed order.
//
// One rotation is a short sequence — confirm the relay is up, record the attempt, drop the
// fingerprint, tell the background, then schedule the reload that opens a fresh socket. Anything
// that cannot be done is reported and the sequence stops, rather than half-completing.

(function () {
    'use strict';

    if (window.__zqDetectReady) return;

    const ZQ = (window.__zq = window.__zq || {});

    // core.js defines ZQ.trace, but engine.js is also exercised on its own (test-transport-recovery
    // loads just this file), and a missing tracer would throw from the rotation path it is describing.
    if (typeof ZQ.trace !== 'function') {
        ZQ.trace = function trace() {};
    }

    // The worker answers in milliseconds when alive. Waiting forever would leave rotating=true,
    // and every later attempt would bail out with the page stuck mid-detect.
    ZQ.RELAY_PROBE_TIMEOUT_MS = 3000;

    // The probe runs in the worker because a content-script fetch is treated as a page request and
    // blocked by CORS in MV3.
    ZQ.relayReady = function relayReady() {
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

    // How soon to look again after a rotation found no relay. The reconnect was just requested, so
    // this only has to cover the host starting its child.
    ZQ.RELAY_RETRY_MS = 2500;

    // How long to leave the page alone after a challenge closes.
    //
    // A challenge that is solved disappears at once, but the detection it was gating has not finished
    // yet - the server answers a moment later. Reloading in that window throws away the result the
    // user just earned, which reads as "it refreshed before I could see anything". Measured on the
    // live page: the container is gone well within the challenge's own poll, so captchaOpen() alone
    // cannot tell "solved, waiting for the answer" apart from "gone, nothing pending".
    ZQ.CHALLENGE_SETTLE_MS = 6000;

    // When a challenge was last seen open. Zero means none has been seen this load.
    ZQ.state.challengeSeenAt = 0;

    // Whether a challenge closed too recently for the page's answer to have arrived.
    //
    // Solving a challenge is what the detection was waiting on, so the response is still in flight
    // for a moment after the container disappears. Everything that would reload the page asks this
    // first; without it the reload beats the answer and the result is never seen.
    //
    // The wait is bounded by time, not by a call count. Measured: two calls 18ms apart exhausted a
    // count-based budget and the reload went ahead while the answer was still coming - the guard was
    // there and did nothing. A deadline cannot be spent by being asked twice.
    ZQ.state.challengeDeferUntil = 0;

    ZQ.awaitingAfterChallenge = function awaitingAfterChallenge() {
        if (!ZQ.state.challengeSeenAt) return false;

        const deadline = ZQ.state.challengeDeferUntil;
        if (deadline && Date.now() < deadline) return true;

        return Date.now() - ZQ.state.challengeSeenAt < ZQ.CHALLENGE_SETTLE_MS;
    };

    // Arms the wait from now, once. Called at the moment a challenge closes - the point the answer
    // starts travelling - so the window is not spent while the user is still solving.
    ZQ.armChallengeDeferral = function armChallengeDeferral() {
        if (!ZQ.state.challengeDeferUntil) {
            ZQ.state.challengeDeferUntil = Date.now() + ZQ.CHALLENGE_SETTLE_MS;
        }

        return Math.max(0, ZQ.state.challengeDeferUntil - Date.now());
    };

    ZQ.scheduleRetry = function scheduleRetry(delayMs) {
        if (!ZQ.state.contextAlive) return;
        if (ZQ.state.retryTimer) clearTimeout(ZQ.state.retryTimer);

        ZQ.writeState({ backoffUntil: Date.now() + delayMs });

        ZQ.state.retryTimer = setTimeout(() => {
            if (!ZQ.state.contextAlive || !ZQ.state.autoRefresh) return;

            if (ZQ.captchaOpen()) {
                ZQ.state.challengeSeenAt = Date.now();
                if (!ZQ.state.challengeWasOpen) {
                    ZQ.state.challengeWasOpen = true;
                    ZQ.trace('challenge-open', null, true);
                }
                ZQ.scheduleRetry(ZQ.CAPTCHA_WAIT_MS);
                return;
            }

            // The transition matters more than the state: the challenge closing is what starts the
            // wait for the answer, and a guard that only samples "is it open now" cannot see it.
            if (ZQ.state.challengeWasOpen) {
                ZQ.state.challengeWasOpen = false;

                // The deadline is set here, at the moment the challenge closes, because that is when
                // the answer starts travelling. Setting it earlier - when the challenge opened - would
                // spend the wait while the user was still solving.
                ZQ.state.challengeDeferUntil = Date.now() + ZQ.CHALLENGE_SETTLE_MS;

                ZQ.trace('challenge-closed', {
                    openForMs: Date.now() - (ZQ.state.challengeSeenAt || Date.now()),
                    state: ZQ.pageState(),
                    waitMs: ZQ.CHALLENGE_SETTLE_MS
                }, true);
            }

            // A challenge that has just closed is still worth waiting for: solving it is what the
            // detection was waiting on, so the answer is on its way. Reloading now would discard it.
            // awaitingAfterChallenge is bounded by a deadline, so a page that never answers rotates.
            if (ZQ.awaitingAfterChallenge()) {
                ZQ.scheduleRetry(ZQ.CAPTCHA_WAIT_MS);
                return;
            }

            // The reload discards the editor's contents, so whatever was pasted is kept first and
            // put back on the other side. Without this a rotation would silently wipe the text the
            // user was in the middle of checking.
            if (typeof ZQ.saveDraft === 'function') ZQ.saveDraft();

            // The last thing recorded before the page is gone. Without it the trail ends mid-story
            // and the reload cannot be told apart from the page being closed.
            ZQ.trace('reload', {
                state: ZQ.pageState(),
                uses: ZQ.identityUses(),
                rotations: ZQ.readState().rotations,
                pageAgeMs: typeof ZQ.pageAge === 'function' ? ZQ.pageAge() : null
            }, true);

            location.reload();
        }, delayMs);
    };

    ZQ.currentState = function currentState(status) {
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

    ZQ.reportState = function reportState(state) {
        ZQ.send({ action: 'statusUpdate', payload: state });
    };

    ZQ.rotate = async function (reason) {
        if (!ZQ.state.enabled || ZQ.state.rotating) return;

        // Auto refresh is the switch for every reload this page performs, not only for the automatic
        // detections: with it off nothing here reloads the page at all, and the reload becomes the
        // user's own decision. The state is reported so the panel says why nothing moved, instead of
        // looking as though the rotation quietly failed.
        if (!ZQ.state.autoRefresh) {
            ZQ.reportState(ZQ.currentState('rotation-suppressed'));
            return;
        }

        // A challenge on screen means the page is waiting on the user, not on a new address.
        // Rotating now would reload mid-challenge and discard their work.
        if (ZQ.captchaOpen()) {
            ZQ.state.challengeSeenAt = Date.now();
            ZQ.state.challengeWasOpen = true;
            ZQ.trace('rotate-deferred', { reason: 'challenge-open' });
            ZQ.scheduleRetry(ZQ.CAPTCHA_WAIT_MS);
            return;
        }

        // A challenge that closed seconds ago has just been solved, and the detection it was gating
        // is still in flight. Rotating here would reload before the answer arrived - the result the
        // user earned would never be seen, which is exactly what "it refreshed before I could read
        // it" describes. scheduleRetry re-checks this and reloads once the answer has had its time.
        if (ZQ.awaitingAfterChallenge()) {
            ZQ.trace('rotate-deferred', {
                reason: 'awaiting-answer',
                sinceChallengeMs: Date.now() - (ZQ.state.challengeSeenAt || 0),
                waitLeftMs: Math.max(0, (ZQ.state.challengeDeferUntil || 0) - Date.now())
            });
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

            // The keepalive alarm runs once a minute, so waiting for it meant the page could sit
            // untouched for most of a minute after the relay died. Asking for a reconnect now and
            // trying again shortly is what makes recovery feel immediate instead of stalled.
            //
            // This must not go through scheduleRetry(): that one reloads the page, and without a
            // relay a reload cannot change the address either, so retrying by reload would loop
            // forever. What is retried here is the rotation attempt itself.
            ZQ.send({ action: 'relayEnsure' });

            if (ZQ.state.retryTimer) clearTimeout(ZQ.state.retryTimer);
            ZQ.state.retryTimer = setTimeout(() => {
                if (!ZQ.state.contextAlive || !ZQ.state.autoRefresh) return;
                ZQ.rotate(reason);
            }, ZQ.RELAY_RETRY_MS);

            return;
        }

        ZQ.writeState({
            rotations: state.rotations + 1,
            failures: 0,
            lastRotationAt: Date.now(),
            ip: 'relay',
            transport: 'relay'
        });

        // A rotation is a fresh start: the challenge bookkeeping belongs to the load being replaced,
        // and carrying it across would make the next load believe an answer is still outstanding.
        ZQ.state.challengeSeenAt = 0;
        ZQ.state.challengeWasOpen = false;
        ZQ.state.challengeDeferUntil = 0;

        ZQ.clearFp();
        ZQ.send({ action: 'logReset', ip: 'relay', reason: reason });

        ZQ.state.rotating = false;

        ZQ.reportState(ZQ.currentState('rotated'));

        // The reload opens a fresh socket. The reloaded page runs identity.js again, which mints a
        // new address, so the reload - not the relay - is what rotates the identity. Kept short
        // because the relay is already confirmed up at this point; nothing is being waited on.
        ZQ.scheduleRetry(400);
    };

    // Only a genuine quota hit justifies a reload. A captcha failure belongs to the user, and an
    // ambiguous refusal is reported without acting.
    ZQ.handlePageState = function handlePageState(reason) {
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
    // How often the page is re-read. Two seconds keeps a spent allowance from sitting on screen
    // while the user wonders whether anything is happening; rotate() already refuses while one is
    // in flight, so a short interval cannot stack reloads.
    ZQ.WATCHDOG_MS = 2000;

    // Returns a function that stops the watchdog, so a dead context can be shut down explicitly.
    // The active stop function is also kept on the namespace, which lets callers that never saw
    // the return value (a test sandbox, an unloading page) tear the timer down.
    ZQ.startWatchdog = function startWatchdog(intervalMs) {
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
            // by its text is best-effort - a variant that does not use the detect wording and whose
            // class neither "detect" nor "check" leaves the count rising with nothing watching it.
            // Reading the stored count makes the trigger exact no matter how the detection started.
            if (ZQ.identitySpent()) {
                // Report it, do not rotate. A rotation is a reload, and the reload destroys the
                // result of the last usable detection: measured at about 1.5s after the count reached
                // the limit, which is why that result was never seen. The address is spent rather
                // than wrong, so the page keeps showing what it has until the user asks for another
                // detection - that press is what rotates, because the press could not be served.
                ZQ.reportSpentOnce();
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

    ZQ.stopWatchdog = function stopWatchdog() {
        if (typeof ZQ._stopWatchdog === 'function') ZQ._stopWatchdog();
    };

    // The shim reports a failed relay attempt here instead of quietly opening the original
    // endpoint. Failing closed is the right default - a direct socket would carry a different
    // address than the one the captcha ticket was issued for - but it leaves the page holding a
    // dead socket, and nothing in the page opens another one.
    //
    // So the recovery is driven from here, and it is bounded on purpose:
    //   * relay offline  -> the rotation path already asks for a reconnect and retries itself,
    //                       then reloads once the relay answers. That path paces itself.
    //   * relay online   -> the failure was not the relay. One reload opens a fresh socket; if that
    //                       socket fails too, reloading again is a loop, and the page would keep
    //                       throwing itself away without ever detecting anything.
    //
    // The budget lives in extension storage - not in memory, and not in localStorage.
    //
    // In memory it is reset by the very reload it bounds, which allows one reload per load forever.
    // In localStorage it is owned by the site: a page script clearing its own storage resets it, and
    // a blocked, full, or silently-dropped write resets it too. Either way the bound disappears,
    // which is the loop it exists to prevent. Extension storage is the one place the counted page
    // cannot write.
    //
    // A reload is the only recovery there is: measured on the live site (tools/diagnostics/
    // diag-sdk-reconnect.cjs), closing the page's socket leaves it closed - the site's SDK creates
    // no replacement, and the page does not reload itself. Nothing else reopens it.
    ZQ.TRANSPORT_RELOAD_KEY = 'zqTransportReloads';
    ZQ.TRANSPORT_RELOAD_LIMIT = 2;
    ZQ.TRANSPORT_RELOAD_WINDOW_MS = 60000;

    function budgetStore() {
        const storage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
        return storage && typeof storage.get === 'function' && typeof storage.set === 'function'
            ? storage
            : null;
    }

    // Wraps the callback API the rest of this extension uses. Rejects on both an exception and a
    // runtime error, so a dead extension context cannot read as "nothing recorded yet".
    function readBudget() {
        return new Promise((resolve, reject) => {
            const store = budgetStore();
            if (!store) { reject(new Error('no storage')); return; }

            try {
                store.get([ZQ.TRANSPORT_RELOAD_KEY], stored => {
                    if (chrome.runtime && chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    resolve(stored ? stored[ZQ.TRANSPORT_RELOAD_KEY] : undefined);
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    function writeBudget(record) {
        return new Promise((resolve, reject) => {
            const store = budgetStore();
            if (!store) { reject(new Error('no storage')); return; }

            try {
                store.set({ [ZQ.TRANSPORT_RELOAD_KEY]: record }, () => {
                    if (chrome.runtime && chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                        return;
                    }
                    resolve();
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    // Strict on purpose: a record that cannot be read exactly is not a record of zero spend.
    function validBudget(record) {
        if (!record || typeof record !== 'object') return null;
        if (!Number.isSafeInteger(record.count) || record.count < 1) return null;
        if (!Number.isFinite(record.at) || record.at <= 0) return null;
        return { count: record.count, at: record.at };
    }

    // Returns the reload count, or null if it cannot be trusted. Unknown is NOT zero: a storage
    // failure must not turn the cross-load limit into one reload per page forever.
    async function transportReloads() {
        let raw;

        try {
            raw = await readBudget();
        } catch (e) {
            return null;
        }

        if (raw === undefined || raw === null) return 0; // Nothing has ever been recorded.

        const record = validBudget(raw);
        if (!record) return null;

        const age = Date.now() - record.at;
        if (age < 0) return null; // A future timestamp must not reset the budget.
        if (age > ZQ.TRANSPORT_RELOAD_WINDOW_MS) return 0;

        return record.count;
    }

    // Confirm persistence by reading it back before permitting the reload. A write that was dropped
    // on the floor must not be mistaken for a durable cross-load budget.
    async function recordTransportReload(count) {
        const record = { count, at: Date.now() };

        try {
            await writeBudget(record);
            const readBack = validBudget(await readBudget());
            return Boolean(readBack) && readBack.count === record.count && readBack.at === record.at;
        } catch (e) {
            return false;
        }
    }

    ZQ.state.transportRetried = false;

    ZQ.handleTransportFailure = async function () {
        if (!ZQ.state.contextAlive || !ZQ.state.enabled || !ZQ.state.autoRefresh) return;
        if (ZQ.state.rotating) return;

        const relayUp = await ZQ.relayReady();

        if (!relayUp) {
            ZQ.rotate('transport-failed');
            return;
        }

        const recorded = await transportReloads();
        if (recorded === null) {
            // Cannot establish a cross-load budget; report the failure rather than guessing zero.
            ZQ.reportState(ZQ.currentState('transport-failed'));
            return;
        }
        const spent = Math.max(recorded, ZQ.state.transportRetried ? 1 : 0);

        // Two separate bounds, because they answer different questions:
        //   * transportRetried - this load already reloaded once; a second failure in the same load
        //     means the reload did not help.
        //   * the stored budget - previous loads already spent their reload on the same failure.
        if (ZQ.state.transportRetried || spent >= ZQ.TRANSPORT_RELOAD_LIMIT) {
            // The relay answers but its sockets keep failing. That is not something a reload fixes,
            // so it is reported and left alone instead of reloading forever.
            ZQ.reportState(ZQ.currentState('transport-failed'));
            return;
        }

        // Never schedule a new reload unless its budget was durably recorded first.
        if (!(await recordTransportReload(spent + 1))) {
            ZQ.reportState(ZQ.currentState('transport-failed'));
            return;
        }
        ZQ.state.transportRetried = true;
        ZQ.reportState(ZQ.currentState('transport-failed'));
        ZQ.scheduleRetry(1200);
    };

    // The hook is optional: a sandbox without DOM event support (the unit tests build one) keeps
    // the rest of the module working, and the shim's announcement is simply unheard there.
    if (typeof window.addEventListener === 'function') {
        // Returned so a caller (a test) can wait for the outcome; the DOM ignores the value.
        window.addEventListener('zq:relay-failed', () => ZQ.handleTransportFailure());

        // What the server actually replied, kept for the trail.
        //
        // The page renders its own wording from these frames, and by the time "Invalid request" is on
        // screen the frame that carried it is gone. Recording it at the boundary is the only place the
        // two can still be compared: a refusal produced by this load and a leftover panel from an
        // earlier one leave the same text behind.
        window.addEventListener('zq:relay-frame', event => {
            const data = event && event.detail ? String(event.detail) : '';

            ZQ.trace('relay-frame', {
                bytes: data.length,
                // Enough of the opening to tell a verdict from a handshake, without storing the
                // report body the page goes on to render.
                head: data.slice(0, 160)
            });
        });
    }
})();
