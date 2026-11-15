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
            if (!ZQ.isAlive()) {
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

    // The challenge cycle: two timestamps and nothing else.
    //
    // A challenge is open, or it closed at some moment. `challengeOpenAt` is when the one on screen
    // appeared (0 when none has been seen this load); `challengeClosedAt` is when the last one
    // disappeared, which is the moment the answer starts travelling, so that is what the settle
    // window measures from.
    //
    // Everything is sampled through observeChallenge() below. Sampling at only some decision points
    // was what made this lifecycle have two clocks: three sites recorded "a challenge is open" by
    // writing the first timestamp without recording the edge, so the settle window had nowhere to
    // start from and a second, coarser time-based criterion had to cover for it.
    ZQ.state.challengeOpenAt = 0;
    ZQ.state.challengeClosedAt = 0;

    // Samples the challenge and records the transition when there is one.
    //
    // Returns what the caller needs to decide, plus the transition to trace. Every decision that
    // would reload the page asks this first, so "is it open" and "when did it close" cannot disagree.
    ZQ.observeChallenge = function observeChallenge() {
        const open = ZQ.captchaOpen();

        if (open) {
            if (ZQ.state.challengeOpenAt) return { open: true, transition: null };
            ZQ.state.challengeOpenAt = Date.now();
            return { open: true, transition: { type: 'challenge-open' } };
        }

        if (!ZQ.state.challengeOpenAt) return { open: false, transition: null };

        const openForMs = Date.now() - ZQ.state.challengeOpenAt;
        ZQ.state.challengeOpenAt = 0;
        ZQ.state.challengeClosedAt = Date.now();
        return { open: false, transition: { type: 'challenge-closed', openForMs: openForMs } };
    };

    // Whether a challenge closed too recently for the page's answer to have arrived.
    //
    // Solving a challenge is what the detection was waiting on, so the response is still in flight
    // for a moment after the container disappears. Everything that would reload the page asks this
    // first; without it the reload beats the answer and the result is never seen.
    //
    // Bounded by a deadline rather than a call count. Measured: two calls 18ms apart exhausted a
    // count-based budget and the reload went ahead while the answer was still coming - the guard was
    // there and did nothing. A deadline cannot be spent by being asked twice.
    ZQ.awaitingAfterChallenge = function awaitingAfterChallenge() {
        if (!ZQ.state.challengeClosedAt) return false;
        return Date.now() - ZQ.state.challengeClosedAt < ZQ.CHALLENGE_SETTLE_MS;
    };

    // Clears the cycle. A rotation replaces the document, so nothing about the old challenge carries
    // over: a page that has just been reloaded cannot be waiting on an answer for it.
    ZQ.resetChallenge = function resetChallenge() {
        ZQ.state.challengeOpenAt = 0;
        ZQ.state.challengeClosedAt = 0;
    };

    ZQ.scheduleRetry = function scheduleRetry(delayMs) {
        if (!ZQ.isAlive()) return;
        if (ZQ.state.retryTimer) clearTimeout(ZQ.state.retryTimer);

        ZQ.writeState({ backoffUntil: Date.now() + delayMs });

        ZQ.state.retryTimer = setTimeout(() => {
            if (!ZQ.canAutoAct()) return;

            const challenge = ZQ.observeChallenge();

            if (challenge.open) {
                if (challenge.transition) ZQ.trace('challenge-open', null, true);
                ZQ.scheduleRetry(ZQ.CAPTCHA_WAIT_MS);
                return;
            }

            // The transition matters more than the state: the challenge closing is what starts the
            // wait for the answer, and a guard that only samples "is it open now" cannot see it.
            if (challenge.transition) {
                ZQ.trace('challenge-closed', {
                    openForMs: challenge.transition.openForMs,
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
            cooldownUntil: state.backoffUntil,
            ip: state.ip,
            signedIn: ZQ.signedIn(),
            // What the page says is left, so the panel can show the number instead of only
            // "ready" and leave the user to open the page and look.
            //
            // Null when the page shows no counter - the exhausted button says "今日次数已用完" with no
            // number in it. Passing the last value seen through would have the panel report an
            // allowance that the page has already spent: the panel said "3 left" while the button
            // said the day's allowance was gone.
            remaining: quota.exhausted ? 0 : quota.remaining,
            quotaExhausted: !!quota.exhausted
        };
    };

    ZQ.reportState = function reportState(state) {
        ZQ.send({ action: 'statusUpdate', payload: state });
    };

    // Rotates the address. `reason` is what the log calls it; `options.manual` marks a request from
    // the person watching, which is the only thing that skips the minimum gap between swaps.
    ZQ.rotate = async function (reason, options) {
        const manual = !!(options && options.manual);
        if (!ZQ.isEnabled() || ZQ.state.rotating) return;

        // Auto refresh is the switch for every reload this page performs, not only for the automatic
        // detections: with it off nothing here reloads the page at all, and the reload becomes the
        // user's own decision. The state is reported so the panel says why nothing moved, instead of
        // looking as though the rotation quietly failed.
        if (!ZQ.canAutoAct()) {
            ZQ.reportState(ZQ.currentState('rotation-suppressed'));
            return;
        }

        // A challenge on screen means the page is waiting on the user, not on a new address.
        // Rotating now would reload mid-challenge and discard their work.
        if (ZQ.observeChallenge().open) {
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
                sinceChallengeMs: Date.now() - (ZQ.state.challengeClosedAt || 0),
                waitLeftMs: Math.max(0, ZQ.CHALLENGE_SETTLE_MS - (Date.now() - ZQ.state.challengeClosedAt))
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

        // The gap keeps the extension from swapping twice in quick succession on its own initiative.
        // A person pressing the button is not that, so the gap does not apply - and it is expressed
        // here, as intent, rather than by blanking the stamp that other decisions read.
        if (!manual) {
            const gap = Date.now() - state.lastRotationAt;

            if (gap < ZQ.MIN_GAP_MS) {
                ZQ.scheduleRetry(ZQ.MIN_GAP_MS - gap);
                return;
            }
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
                if (!ZQ.canAutoAct()) return;
                ZQ.rotate(reason);
            }, ZQ.RELAY_RETRY_MS);

            return;
        }

        ZQ.writeState({
            rotations: state.rotations + 1,
            lastRotationAt: Date.now(),
            // The wait belongs to the address being replaced, so the new one starts unspent and
            // without a clock already running against it.
            spentSince: 0,
            ip: 'relay'
        });

        // A rotation is a fresh start: the challenge cycle belongs to the load being replaced, and
        // carrying it across would make the next load believe an answer is still outstanding.
        ZQ.resetChallenge();

        ZQ.clearFp();
        ZQ.send({ action: 'logReset', ip: 'relay', reason: reason });

        ZQ.state.rotating = false;

        ZQ.reportState(ZQ.currentState('rotated'));

        // The reload opens a fresh socket. The reloaded page runs identity.js again, which mints a
        // new address, so the reload - not the relay - is what rotates the identity. Kept short
        // because the relay is already confirmed up at this point; nothing is being waited on.
        ZQ.scheduleRetry(400);
    };

    // What the page shows. A captcha failure belongs to the user, and an ambiguous refusal is
    // reported without acting; only a spent address is acted on, and how is not decided here - see
    // onAddressSpent, which is the one place that answers it.
    ZQ.handlePageState = function handlePageState(reason) {
        const state = ZQ.pageState();

        if (state === 'quota') {
            ZQ.onAddressSpent(reason);
            return;
        }

        if (state !== 'ok') {
            ZQ.reportState(ZQ.currentState(state));
        }
    };

    // A rotation the user asked for. It still refuses inside a challenge, because reloading there
    // would discard the work being solved, but it does not respect the spent-address hold or the
    // quota cooldown: both exist to stop the extension acting on its own, and neither applies when
    // the request came from the person watching.
    ZQ.forceRotate = function forceRotate(reason) {
        if (!ZQ.isEnabled()) return;

        if (ZQ.observeChallenge().open) {
            ZQ.trace('rotate-deferred', { reason: 'challenge-open', requested: true });
            ZQ.scheduleRetry(ZQ.CAPTCHA_WAIT_MS);
            return;
        }

        ZQ.rotate(reason || 'manual', { manual: true });
    };

    // What to do once this address has served all its detections.
    //
    // The server allows five per address and then reports zero, so the address has to change; the only
    // question is when. The three answers cost different things and none is right for every use, which
    // is why this is a stored preference rather than a constant.
    ZQ.readSpentMode = function readSpentMode() {
        const mode = ZQ.state.spentMode;
        return ZQ.SPENT_MODES.indexOf(mode) !== -1 ? mode : 'manual';
    };

    // How long to wait before swapping on the 'delay' setting, in ms. The panel stores seconds.
    ZQ.readSpentDelayMs = function readSpentDelayMs() {
        const seconds = Number(ZQ.state.spentDelaySeconds);
        return (Number.isFinite(seconds) && seconds > 0 ? seconds : 30) * 1000;
    };

    // How long the swap modes have to wait after a rotation before they may swap again.
    ZQ.QUOTA_ROTATE_COOLDOWN_MS = 30000;

    // Whether this address has served everything it can.
    //
    // Two things can say so: the count this tab has recorded, and the page saying its allowance is
    // gone. They are the same question, so they are asked in one place - a caller that answers it for
    // itself is how the page came to reload while the panel was set to keep it.
    ZQ.addressSpent = function addressSpent() {
        return ZQ.identitySpent() || ZQ.pageState() === 'quota';
    };

    // The one decision about what happens once the address is spent.
    //
    // Nothing else reloads the page for this reason. The answer is the user's stored choice, and the
    // two modes that keep the page must keep it on every path, not only on the one that noticed.
    ZQ.onAddressSpent = function onAddressSpent(reason) {
        const mode = ZQ.readSpentMode();

        // Both modes that swap are paced by the same cooldown, because both can be reached from the
        // observer, which fires on every DOM change while a page mid-detection changes constantly.
        // Measured over nine minutes of a single session without it: 176 reloads and 138 loads,
        // peaking at 46 in one minute - the reload destroys the page about to report the real state,
        // the fresh page looks spent again for a moment, and the cycle repeats.
        if (mode === 'immediate' || mode === 'delay') {
            const since = Date.now() - (Number(ZQ.readState().lastRotationAt) || 0);

            if (since < ZQ.QUOTA_ROTATE_COOLDOWN_MS) {
                ZQ.trace('quota-cooldown', { since, mode, reason });
                ZQ.reportState(ZQ.currentState('quota'));
                return;
            }
        }

        if (mode === 'immediate') {
            ZQ.trace('spent-swap', { mode, reason, uses: ZQ.identityUses() });
            ZQ.forceRotate('spent');
            return;
        }

        if (mode === 'delay') {
            // The wait lives in storage, not in memory: a wait that restarts on every reload would
            // never finish on a page the user reloads, and this one reloads itself.
            const held = Number(ZQ.readState().spentSince) || 0;
            const waitMs = ZQ.readSpentDelayMs();

            if (!held) {
                ZQ.writeState({ spentSince: Date.now() });
                ZQ.reportSpentOnce();
                return;
            }

            if (Date.now() - held >= waitMs) {
                ZQ.writeState({ spentSince: 0 });
                ZQ.trace('spent-swap', { mode, reason, waited: Date.now() - held, waitMs });
                ZQ.forceRotate('spent');
                return;
            }

            ZQ.reportSpentOnce();
            return;
        }

        // 'manual' and 'press' both keep the page. 'press' swaps at the press itself, which is handled
        // where the press is - that is the only place that knows the address was what the press could
        // not be served from.
        ZQ.reportSpentOnce();
    };

    // The watchdog asks on a timer, so a page that is exhausted and sitting still is noticed without
    // needing a DOM change or a click.
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
            if (!ZQ.isAlive()) {
                stop();
                return;
            }

            if (!ZQ.canRotate()) return;

            // The address limit is checked here, not only after a click. Detecting the detect button
            // by its text is best-effort - a variant that does not use the detect wording and whose
            // class neither "detect" nor "check" leaves the count rising with nothing watching it.
            // Asking the page as well makes the trigger exact no matter how the detection started.
            if (!ZQ.addressSpent()) return;

            ZQ.onAddressSpent('watchdog');
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
        if (!ZQ.canRotate()) return;

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
                body: data
            });
        });

        // And what was asked, whole.
        //
        // The outbound side is where the unanswered question is: the server answers code 21 when it
        // rejects the captcha ticket, and telling a reused ticket from one signed for another address
        // needs the ticket that was actually sent. Replies alone said what came back, never what
        // produced it.
        window.addEventListener('zq:relay-sent', event => {
            const data = event && event.detail ? String(event.detail) : '';

            ZQ.trace('relay-sent', {
                bytes: data.length,
                body: data
            });
        });
    }
})();
