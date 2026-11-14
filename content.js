(function() {
    'use strict';

    // The manifest injects this file, and background.js re-injects it after
    // navigation. Bail out so listeners are not registered twice.
    if (window.__zqDetectInjected) return;
    window.__zqDetectInjected = true;

    const FP_KEYS = ['fp', 'fingerprint', 'device_fp'];

    // Bookkeeping lives in localStorage: the site clears sessionStorage on load,
    // which used to wipe the counters and let the loop restart from zero.
    const STATE_KEY = 'zqRotationState';

    // The server throttles bursts per client IP. Each rotation now also changes
    // the address, so the pacing only needs to stay civil, not defensive.
    const MIN_GAP_MS = 2500;

    let enabled = true;
    let autoRefresh = true;
    let rotating = false;
    let retryTimer = null;

    // --- identity ------------------------------------------------------------
    // The captcha ticket is bound to the address that fetched it. The page fetches its own ticket
    // over plain HTTPS, so the socket has to carry the same address or the ticket is refused with
    // "Invalid request". This script therefore picks one address per page load, hands it to the
    // socket through localStorage (read synchronously by shim.js) and to the background for the
    // request-header rule. One load is one identity, which is also what rotation needs.

    const IDENTITY_KEY = 'zqXff';

    // Same address ranges the relay draws from, so a chosen identity looks like a normal client.
    const IDENTITY_PREFIXES = [
        '112.80', '112.82', '112.51', '112.55', '112.157', '112.214',
        '116.25', '120.204', '183.192', '221.226', '58.216', '61.147',
        '180.97', '182.61', '39.156', '223.5', '106.11', '121.40',
        '118.31', '121.199', '140.205', '47.96', '101.226', '175.6',
        '222.186', '110.184', '171.88', '125.64', '182.150', '119.147'
    ];

    function randomIdentity() {
        const prefix = IDENTITY_PREFIXES[Math.floor(Math.random() * IDENTITY_PREFIXES.length)];
        const octet = () => 1 + Math.floor(Math.random() * 254);
        return `${prefix}.${octet()}.${octet()}`;
    }

    // A page load keeps its identity for as long as it lasts, so the socket and the captcha request
    // made moments later agree. It is NOT carried over to the next load. Measured against the real
    // server: one address serves four handshakes and is refused from the fifth onwards, permanently
    // ({"status":"failed","msg":"Invalid request"}), while a fresh one is accepted every time. The
    // limit is per address, not per prefix - an untouched neighbour in the same /24 still works.
    // Restoring a stored value would therefore burn that address and leave the extension unable to
    // detect anything at all.
    let loadIdentity = null;

    // Measured, not assumed: see the note above. The reload has to happen before the fifth
    // handshake, and it must never happen while the user is completing the captcha by hand.
    const USES_PER_IDENTITY = 4;

    // Bumped by shim.js on every relay socket it opens. Reading the real count is what makes the
    // reload decision correct: a page load reuses one socket for several detections, so counting
    // clicks would reload at the wrong moment.
    const USE_COUNT_KEY = 'zqXffUses';

    function identityUses() {
        try {
            const stored = Number(localStorage.getItem(USE_COUNT_KEY));
            return Number.isFinite(stored) && stored > 0 ? stored : 0;
        } catch (e) {
            // Storage blocked: assume no uses, so the page is left alone rather than reloaded
            // blindly.
            return 0;
        }
    }

    function ensureIdentity() {
        if (loadIdentity) return loadIdentity;

        loadIdentity = randomIdentity();

        try {
            localStorage.setItem(IDENTITY_KEY, loadIdentity);
            // A new address starts with a clean handshake count, so the reload that follows is
            // governed by this address's own uses.
            localStorage.setItem(USE_COUNT_KEY, '0');
        } catch (e) {
            // Storage can be unavailable on a locked-down profile; the socket then falls back to
            // whatever the relay picks.
        }

        return loadIdentity;
    }

    function publishIdentity(identity) {
        try {
            chrome.runtime.sendMessage({ action: 'setIdentity', ip: identity }, () => {
                // A missing worker is not this script's problem to fix; the rule simply stays as it
                // was for this load.
                void chrome.runtime.lastError;
            });
        } catch (e) {
            // Extension context gone; nothing to publish to.
        }
    }

    function readState() {
        try {
            const raw = localStorage.getItem(STATE_KEY);

            if (!raw) return { rotations: 0, failures: 0, backoffUntil: 0, lastRotationAt: 0, ip: null, transport: null };

            const parsed = JSON.parse(raw);

            return {
                rotations: Number(parsed.rotations) || 0,
                failures: Number(parsed.failures) || 0,
                backoffUntil: Number(parsed.backoffUntil) || 0,
                lastRotationAt: Number(parsed.lastRotationAt) || 0,
                ip: typeof parsed.ip === 'string' ? parsed.ip : null,
                transport: typeof parsed.transport === 'string' ? parsed.transport : null
            };
        } catch (e) {
            return { rotations: 0, failures: 0, backoffUntil: 0, lastRotationAt: 0, ip: null, transport: null };
        }
    }

    function writeState(patch) {
        const next = Object.assign(readState(), patch);

        try {
            localStorage.setItem(STATE_KEY, JSON.stringify(next));
        } catch (e) {
        }

        return next;
    }

    // With an account, the allowance is tied to the uid rather than the fp, so
    // rotating would only cost a reload.
    function signedIn() {
        try {
            const token = localStorage.getItem('aiGenAccessToken');

            if (!token) return false;

            const parsed = JSON.parse(token);

            return !!(parsed && parsed.uid);
        } catch (e) {
            return false;
        }
    }

    // Reloading the extension leaves the previous content script running in
    // already-open tabs, where every chrome.* call throws "Extension context
    // invalidated". Once that happens there is nothing useful this script can
    // do — the page keeps working and a reload injects a fresh copy — so it goes
    // quiet instead of throwing into the page's uncaught-error handler.
    let contextAlive = true;

    function isInvalidated(error) {
        return String((error && error.message) || error || '').includes('Extension context invalidated');
    }

    function noteContextError(error) {
        if (!isInvalidated(error)) return;

        contextAlive = false;

        // A reload that was already scheduled would still fire, throwing the user
        // out of a page they are working in for no benefit: the replacement
        // script only arrives after that reload, and it re-reads this state.
        if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = null;
            writeState({ backoffUntil: 0 });
        }
    }

    // Sends a message and never throws: returns null when the context is gone.
    function sendMessage(message) {
        if (!contextAlive) return Promise.resolve(null);

        try {
            return Promise.resolve(chrome.runtime.sendMessage(message)).catch(error => {
                noteContextError(error);
                return null;
            });
        } catch (error) {
            noteContextError(error);
            return Promise.resolve(null);
        }
    }

    function reportState(state) {
        sendMessage({ action: 'statusUpdate', payload: state });
    }

    function currentState(status) {
        const state = readState();

        return {
            at: Date.now(),
            status: status || 'idle',
            rotations: state.rotations,
            failures: state.failures,
            cooldownUntil: state.backoffUntil,
            ip: state.ip,
            transport: state.transport || null,
            signedIn: signedIn()
        };
    }

    // Chinese literals below are the site's own wording; they are matched
    // Classified deliberately, because the response decides whether the page is
    // reloaded. "Invalid request" is NOT a quota signal: the server also answers
    // it when the captcha ticket is missing or rejected. Treating it as
    // exhaustion made the extension reload in a loop while the real cause was an
    // unsolved captcha, which rotation can never fix.
    const QUOTA_PHRASES = [
        '今日免费次数已用完',
        '已达到今日免费检测次数',
        '今日剩余次数：0',
        '今日剩余次数:0'
    ];

    // The counter lives inside the detect button — "立即检测(今日剩余5次)" — and its wording changes
    // as the count falls, ending as "今日次数已用完". The enumerated list above can never cover every
    // variant: that final wording was missing from it, so a spent allowance read as 'ok' and rotation
    // never started. The number is parsed instead, and exhaustion is matched by pattern.
    const QUOTA_REMAINING = /今日剩余\s*(\d+)\s*次/;
    const QUOTA_EXHAUSTED = /(今日免费次数已用完|已达到今日免费检测次数|次数已用完|次数用尽|额度已用完|今日剩余次数\s*[:：]\s*0)/;

    const CAPTCHA_PHRASES = [
        '验证失败',
        '请完成验证',
        '请先完成验证'
    ];

    // How soon to look again while the user is completing a challenge. Short enough that the reload
    // follows the challenge closely, long enough not to spin while it is open.
    const CAPTCHA_WAIT_MS = 2000;

    // The challenge itself is rendered in an iframe owned by the captcha SDK, so none of its text
    // reaches document.body.innerText and CAPTCHA_PHRASES above cannot see it. The element is the
    // only reliable signal. Measured on the live page, the SDK keeps its container in the DOM at
    // all times and hides it by moving it far off-screen, not by collapsing it:
    //
    //   div#tcaptcha_wrapper_transform_dy  offsetWidth 300  rect.y -1000000  opacity 0
    //   iframe#tcaptcha_iframe_dy          offsetWidth 300  rect.y -1000000
    //
    // So size is useless here - it reads as present even with no challenge on screen, which would
    // block every reload forever. What separates a live challenge is that it is actually inside the
    // viewport and opaque. The template varies (drag image, pick-the-slowest, pick the matching
    // item) but the container does not.
    function captchaOpen() {
        const element = document.getElementById('tcaptcha_iframe_dy') ||
            document.getElementById('tcaptcha_iframe') ||
            document.getElementById('tcaptcha_transform') ||
            document.getElementById('tcaptcha_wrapper_transform_dy') ||
            document.querySelector('.tcaptcha-transform');

        if (!element) return false;

        const rect = element.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) return false;

        const viewWidth = window.innerWidth || document.documentElement.clientWidth;
        const viewHeight = window.innerHeight || document.documentElement.clientHeight;

        // Off-screen in any direction means hidden, which is how the SDK parks it.
        if (rect.bottom <= 0 || rect.right <= 0) return false;
        if (rect.top >= viewHeight || rect.left >= viewWidth) return false;

        // And it has to be opaque: a container parked transparent, or one still fading in, is not
        // asking the user anything yet.
        for (let node = element, depth = 0; node && depth < 8; node = node.parentElement, depth += 1) {
            const style = window.getComputedStyle(node);
            if (!style) break;
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            if (Number(style.opacity) === 0) return false;
        }

        return true;
    }

    // Neither quota nor captcha: an opaque server refusal. Kept so the caller can
    // report it, but it must not trigger automatic rotation.
    const AMBIGUOUS_PHRASES = [
        'Invalid request'
    ];

    function pageText() {
        return document.body ? (document.body.innerText || '') : '';
    }

    function matched(phrases) {
        const text = pageText();
        return phrases.some(phrase => text.includes(phrase));
    }

    // Returns how many detections the page says are left, and whether it says none are.
    // `remaining` is null when the page shows no counter at all.
    function readQuota(text) {
        const source = typeof text === 'string' ? text : pageText();
        const counted = source.match(QUOTA_REMAINING);
        const remaining = counted ? Number(counted[1]) : null;

        // A visible positive count wins over any stale exhausted wording left elsewhere on the page:
        // the counter is the live value, and acting on a stale one would reload needlessly.
        if (remaining !== null && remaining > 0) return { remaining: remaining, exhausted: false };

        if (remaining === 0) return { remaining: 0, exhausted: true };
        if (QUOTA_EXHAUSTED.test(source)) return { remaining: remaining, exhausted: true };

        return { remaining: remaining, exhausted: false };
    }

    function pageState() {
        const text = pageText();

        if (readQuota(text).exhausted) return 'quota';
        if (matched(CAPTCHA_PHRASES)) return 'captcha';
        if (matched(AMBIGUOUS_PHRASES)) return 'ambiguous';
        return 'ok';
    }

    // Drop the fp so the page's own setFp() derives a fresh one from the
    // browser's visitorId. A hand-written random fp is refused by the server.
    function clearFp() {
        try {
            FP_KEYS.forEach(key => {
                localStorage.removeItem(key);
                sessionStorage.removeItem(key);
            });

            document.cookie = 'fp=; path=/; max-age=0';
            document.cookie = 'fingerprint=; path=/; max-age=0';
        } catch (e) {
        }
    }

    // The worker answers in milliseconds when it is alive. Waiting forever would
    // leave rotate() stuck with rotating=true, so every later attempt would bail
    // out and the page would stay mid-detect with nothing happening.
    const RELAY_PROBE_TIMEOUT_MS = 3000;

    // The relay carries the socket and rotates the address per connection, so
    // nothing has to be attached to the browser and no debug bar appears. The
    // probe runs in the worker because content-script fetches hit CORS in MV3.
    function relayReady() {
        return new Promise(resolve => {
            if (!contextAlive) {
                resolve(false);
                return;
            }

            let settled = false;
            let timeout = null;

            // Every path settles exactly once, and always clears the timer.
            const finish = ok => {
                if (settled) return;

                settled = true;

                if (timeout) clearTimeout(timeout);
                resolve(ok);
            };

            timeout = setTimeout(() => finish(false), RELAY_PROBE_TIMEOUT_MS);

            try {
                const pending = chrome.runtime.sendMessage({ action: 'relayHealth' }, response => {
                    // Reading lastError on a dead context also throws.
                    try {
                        if (chrome.runtime.lastError) {
                            finish(false);
                            return;
                        }
                    } catch (error) {
                        noteContextError(error);
                        finish(false);
                        return;
                    }

                    finish(!!(response && response.ok));
                });

                // The callback form still returns a Promise in some Chrome builds,
                // and that Promise rejects if the context dies before delivery.
                if (pending && typeof pending.catch === 'function') {
                    pending.catch(error => {
                        noteContextError(error);
                        finish(false);
                    });
                }
            } catch (error) {
                noteContextError(error);
                finish(false);
            }
        });
    }

    function scheduleRetry(delayMs) {
        // A stale content script must not schedule new reloads after its
        // extension context has been invalidated.
        if (!contextAlive) return;
        if (retryTimer) clearTimeout(retryTimer);

        writeState({ backoffUntil: Date.now() + delayMs });

        retryTimer = setTimeout(() => {
            if (!contextAlive || !autoRefresh) return;

            // The captcha is the user's to solve, and a reload here would throw their work away
            // mid-challenge. Wait for it to close instead. Re-checking keeps this from being a
            // one-shot miss: the reload happens on its own once the challenge is gone.
            if (captchaOpen()) {
                scheduleRetry(CAPTCHA_WAIT_MS);
                return;
            }

            location.reload();
        }, delayMs);
    }

    async function rotate(reason) {
        if (!enabled || rotating) return;

        // A challenge on screen means the page is waiting on the user, not on a new address.
        // Rotating now would reload mid-challenge and discard their work.
        if (captchaOpen()) {
            scheduleRetry(CAPTCHA_WAIT_MS);
            return;
        }

        const state = readState();

        if (Date.now() < state.backoffUntil) {
            scheduleRetry(state.backoffUntil - Date.now());
            return;
        }

        if (signedIn()) {
            reportState(currentState('signed-in'));
            return;
        }

        const gap = Date.now() - state.lastRotationAt;

        if (gap < MIN_GAP_MS) {
            scheduleRetry(MIN_GAP_MS - gap);
            return;
        }

        rotating = true;

        // The relay is the only transport. Without it there is no way to change
        // the client address, and the only other API that can is the debugger —
        // which would put Chromium's debug bar back on screen. The page is left
        // alone instead.
        const viaRelay = await relayReady();

        if (!viaRelay) {
            rotating = false;
            reportState(currentState('relay-offline'));
            return;
        }

        writeState({
            rotations: state.rotations + 1,
            failures: 0,
            lastRotationAt: Date.now(),
            ip: 'relay',
            transport: 'relay'
        });

        clearFp();

        sendMessage({ action: 'logReset', ip: 'relay', reason: reason });

        rotating = false;

        reportState(currentState('rotated'));

        // The reload is what opens a fresh socket. The reloaded page runs this script again, which
        // picks a new address, so the reload - not the relay - is what rotates the identity.
        scheduleRetry(1200);
    }

    // Only a genuine quota hit justifies a reload. A captcha failure is the
    // user's to resolve, and an ambiguous refusal is reported without acting —
    // rotating on it is what produced the reload loop the review found.
    function handlePageState(reason) {
        const state = pageState();

        if (state === 'quota') {
            rotate(reason);
            return;
        }

        if (state !== 'ok') {
            reportState(currentState(state));
        }
    }

    function watchResults() {
        // The result panel is re-rendered rather than appended, so observe the
        // subtree instead of polling on a timer.
        const observer = new MutationObserver(() => {
            if (!enabled || rotating) return;
            handlePageState('quota');
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    function monitorUsage() {
        document.addEventListener('click', (e) => {
            const target = e.target;
            const text = target.textContent || '';
            const rawClassName = target.className;
            // SVGElement.className is an SVGAnimatedString, not a JS string.
            // Normalize it before substring checks so clicks on SVG icons do not
            // throw from this document-level listener.
            const className = typeof rawClassName === 'string'
                ? rawClassName
                : rawClassName && typeof rawClassName.baseVal === 'string'
                    ? rawClassName.baseVal
                    : '';

            // NOTE: the Chinese literals below are the site's own button labels.
            if (text.includes('检测') || text.includes('立即检测') ||
                className.includes('detect') || className.includes('check')) {
                sendMessage({ action: 'usageIncrement' });

                setTimeout(() => {
                    if (!enabled || rotating) return;

                    // Measured: an address serves four handshakes and is refused from the fifth
                    // onwards with "Invalid request". Reloading before that point costs nothing and
                    // moves the page onto a fresh address, so the user never sees that refusal.
                    // Deciding on the count rather than on the refusal keeps rotate() off an
                    // ambiguous message, which is what once caused a reload loop.
                    if (identityUses() >= USES_PER_IDENTITY) {
                        rotate('identity-exhausted');
                        return;
                    }

                    handlePageState('quota-after-click');
                }, 2500);
            }
        });
    }

    // A page that already shows a spent allowance and then sits still produces no DOM change and no
    // click, so neither trigger above fires — and that is the common case, because the user opens the
    // page after the allowance is gone. This asks on a timer instead of waiting to be told.
    //
    // rotate() refuses while a rotation is in flight and inside its cooldown, so a tick during a
    // pending reload cannot stack another one.
    const WATCHDOG_MS = 5000;

    let watchdogTimer = null;

    function startWatchdog(intervalMs) {
        const every = intervalMs || WATCHDOG_MS;

        const stop = () => {
            if (watchdogTimer) clearInterval(watchdogTimer);
            watchdogTimer = null;
        };

        const tick = () => {
            // A reloading extension leaves this script running with every chrome.* call throwing; it
            // must stop asking rather than keep scheduling reloads.
            if (!contextAlive) {
                stop();
                return;
            }

            if (!enabled || !autoRefresh || rotating) return;

            // The address limit is checked here, not only after a click. Detecting the button by its
            // text is best-effort - a variant that does not say "检测" and whose class carries neither
            // "detect" nor "check" leaves the count rising with nothing watching it. Then the fifth
            // handshake is refused and the page shows "Invalid request", which no rotation can undo
            // because the address is already burned. Reading the stored count makes the trigger exact
            // no matter where the detection was started from.
            if (identityUses() >= USES_PER_IDENTITY) {
                rotate('identity-exhausted');
                return;
            }

            if (pageState() !== 'quota') return;

            handlePageState('watchdog');
        };

        stop();
        watchdogTimer = setInterval(tick, every);
        return stop;
    }

    // Registering listeners also throws on a dead context, so the whole setup is
    // guarded: a stale script simply does nothing.
    try {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action === 'toggle') {
                enabled = request.enabled;
                sendResponse({ status: 'success' });
            } else if (request.action === 'getStatus') {
                sendResponse(currentState(pageState()));
            } else if (request.action === 'autoRefresh') {
                autoRefresh = request.enabled;
                sendResponse({ status: 'success' });
            } else if (request.action === 'manualReset') {
                writeState({ failures: 0, backoffUntil: 0, lastRotationAt: 0 });

                if (retryTimer) clearTimeout(retryTimer);
                retryTimer = null;

                rotating = false;
                rotate('manual');
                sendResponse({ status: 'success' });
            }

            // Every action handled by this listener responds synchronously.
            // Unknown actions do not respond at all, so returning true would
            // leave their message channels open indefinitely.
            return false;
        });
    } catch (error) {
        noteContextError(error);
    }

    monitorUsage();
    watchResults();

    // Pick this load's identity before anything is sent, and tell the background so it can put the
    // same address on the page's own captcha request.
    publishIdentity(ensureIdentity());

    // The panel writes autoRefresh to storage; without reading it here the
    // switch would flip in the UI while this script kept reloading anyway.
    try {
        chrome.storage.local.get(['autoRefresh'], state => {
            autoRefresh = state.autoRefresh !== false;
        });

        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local' || !changes.autoRefresh) return;

            autoRefresh = changes.autoRefresh.newValue !== false;

            // Turning it off must also cancel a reload that is already scheduled.
            if (!autoRefresh && retryTimer) {
                clearTimeout(retryTimer);
                retryTimer = null;
                writeState({ backoffUntil: 0 });
            }
        });
    } catch (error) {
        noteContextError(error);
    }

    // A fresh load starts on whatever address the background already installed;
    // report it so the panel shows the live value.
    reportState(currentState(signedIn() ? 'signed-in' : 'idle'));

    // Ask on a timer too, so a page that is already exhausted and then sits still
    // rotates without the user clicking anything.
    startWatchdog();
})();
