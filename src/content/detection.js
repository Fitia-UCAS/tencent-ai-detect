// Reading the page: what state it is in, and the local bookkeeping around it.
//
// The phrase tables below are the site's own wording. Classification decides whether the page is
// reloaded, so the distinction between "quota exhausted" and "opaque refusal" matters: the server
// also answers Invalid request when the captcha ticket is missing or rejected, and rotating on
// that produced a reload loop while the real cause was an unsolved captcha.

(function () {
    'use strict';

    if (window.__zqDetectReady) return;

    const ZQ = (window.__zq = window.__zq || {});
    const EMPTY_STATE = Object.freeze({
        rotations: 0,
        failures: 0,
        backoffUntil: 0,
        lastRotationAt: 0,
        ip: null,
        transport: null
    });

    ZQ.QUOTA_PHRASES = [
        '今日免费次数已用完',
        '已达到今日免费检测次数',
        '今日剩余次数：0',
        '今日剩余次数:0'
    ];

    // The site's counter is part of the detect button - "detect (5 left today)" in its own wording - and
    // the wording changes as the count falls, ending in an exhausted form. An enumerated list can
    // never cover every variant: the exhausted wording was missing from it, so an empty quota read
    // as Ready and rotation never started. The count is parsed instead, and exhaustion is matched
    // by pattern rather than by exact string.
    ZQ.QUOTA_REMAINING = /今日剩余\s*(\d+)\s*次/;
    ZQ.QUOTA_EXHAUSTED = /(今日免费次数已用完|已达到今日免费检测次数|次数已用完|次数用尽|额度已用完|今日剩余次数\s*[:：]\s*0)/;

    ZQ.CAPTCHA_PHRASES = [
        '验证失败',
        '请完成验证',
        '请先完成验证'
    ];

    // Neither quota nor captcha: an opaque refusal. Reported, never acted on.
    ZQ.AMBIGUOUS_PHRASES = ['Invalid request'];

    ZQ.readState = function () {
        try {
            const raw = localStorage.getItem(ZQ.STATE_KEY);
            if (!raw) return { ...EMPTY_STATE };

            const parsed = JSON.parse(raw);

            return {
                rotations: Number(parsed.rotations) || 0,
                failures: Number(parsed.failures) || 0,
                backoffUntil: Number(parsed.backoffUntil) || 0,
                lastRotationAt: Number(parsed.lastRotationAt) || 0,
                ip: typeof parsed.ip === 'string' ? parsed.ip : null,
                transport: typeof parsed.transport === 'string' ? parsed.transport : null
            };
        } catch {
            return { ...EMPTY_STATE };
        }
    };

    ZQ.writeState = function (patch) {
        const next = Object.assign(ZQ.readState(), patch);

        try {
            localStorage.setItem(ZQ.STATE_KEY, JSON.stringify(next));
        } catch {
            // Private mode or a full quota. The in-memory result is still returned so the caller
            // can keep going; only persistence is lost.
        }

        return next;
    };

    // With an account the allowance is tied to the uid rather than the fp, so rotating would only
    // cost a reload without changing anything.
    ZQ.signedIn = function () {
        try {
            const token = localStorage.getItem('aiGenAccessToken');
            if (!token) return false;

            const parsed = JSON.parse(token);
            return !!(parsed && parsed.uid);
        } catch {
            return false;
        }
    };

    // Returns how many detections the page says are left, and whether it says none are.
    // `remaining` is null when the page shows no counter at all.
    ZQ.readQuota = function (text) {
        const source = typeof text === 'string' ? text : (document.body ? document.body.innerText || '' : '');
        const counted = source.match(ZQ.QUOTA_REMAINING);
        const remaining = counted ? Number(counted[1]) : null;

        // A visible positive count wins over any stale exhausted wording left elsewhere on the
        // page: the counter is the live value, and acting on a stale one would reload needlessly.
        if (remaining !== null && remaining > 0) return { remaining, exhausted: false };

        if (remaining === 0) return { remaining: 0, exhausted: true };
        if (ZQ.QUOTA_EXHAUSTED.test(source)) return { remaining, exhausted: true };

        return { remaining, exhausted: false };
    };

    ZQ.pageState = function () {
        const text = document.body ? (document.body.innerText || '') : '';

        if (ZQ.readQuota(text).exhausted) return 'quota';
        if (ZQ.CAPTCHA_PHRASES.some(phrase => text.includes(phrase))) return 'captcha';
        if (ZQ.AMBIGUOUS_PHRASES.some(phrase => text.includes(phrase))) return 'ambiguous';
        return 'ok';
    };

    // Whether the challenge is on screen and waiting for the user.
    //
    // The phrases above cannot answer this: the challenge is rendered in an iframe owned by the
    // captcha SDK, so its text never reaches body.innerText. Measured on the live page, the
    // container is in the DOM at all times and hidden by being parked far off-screen, not by being
    // collapsed:
    //
    //   div#tcaptcha_wrapper_transform_dy  offsetWidth 300  rect.y -1000000  opacity 0
    //   iframe#tcaptcha_iframe_dy          offsetWidth 300  rect.y -1000000
    //
    // So size is useless here - it reads as present even with no challenge on screen, which would
    // block every reload forever and look like nothing happening. What separates a live challenge is
    // that it is inside the viewport and opaque. The template varies (drag image, pick the slowest,
    // pick the matching item); the container does not.
    ZQ.captchaOpen = function () {
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
    };

    // Drop the fp so the page's own setFp() derives a fresh one from the browser's visitorId.
    // A hand-written random fp is refused by the server.
    ZQ.clearFp = function () {
        try {
            for (const key of ZQ.FP_KEYS) {
                localStorage.removeItem(key);
                sessionStorage.removeItem(key);
            }

            document.cookie = 'fp=; path=/; max-age=0';
            document.cookie = 'fingerprint=; path=/; max-age=0';
        } catch {
            // Storage can be unavailable; the rotation still proceeds with the address change.
        }
    };
})();
