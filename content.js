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

    const CAPTCHA_PHRASES = [
        '验证失败',
        '请完成验证',
        '请先完成验证'
    ];

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

    function pageState() {
        if (matched(QUOTA_PHRASES)) return 'quota';
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
            if (contextAlive && autoRefresh) location.reload();
        }, delayMs);
    }

    async function rotate(reason) {
        if (!enabled || rotating) return;

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

        // The reload is what opens a fresh socket, and the relay hands that new
        // socket a new client address.
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
                    if (enabled && !rotating) handlePageState('quota-after-click');
                }, 2500);
            }
        });
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
})();
