(function() {
    'use strict';

    let enabled = true;
    let autoRefresh = true;
    let hasReplaced = false;

    function monitorUsage() {
        // Count clicks that look like a "run detection" action: either the
        // button label matches the site's Chinese wording, or the class name
        // hints at a detect/check control.
        document.addEventListener('click', (e) => {
            const target = e.target;
            const text = target.textContent || '';
            const className = target.className || '';

            // NOTE: the Chinese literals below are the site's own button labels.
            // They are used for DOM matching, not for display, so they must stay as-is.
            if (text.includes('检测') || text.includes('立即检测') ||
                className.includes('detect') || className.includes('check')) {
                chrome.runtime.sendMessage({action: 'usageIncrement'});

                // The result panel renders asynchronously; check it a moment later.
                setTimeout(() => {
                    checkAndReplace();
                }, 2000);
            }
        });

        // Poll as a fallback for quota banners that appear without a click.
        setInterval(() => {
            checkAndReplace();
        }, 5000);
    }

    function checkAndReplace() {
        if (!enabled) return;

        const pageText = document.body.innerText;

        // NOTE: these Chinese phrases are quota / captcha messages from the site.
        // They are matched against page text and must not be translated.
        if (pageText.includes('今日免费次数已用完') ||
            pageText.includes('已达到今日免费检测次数') ||
            pageText.includes('今日剩余次数：0') ||
            pageText.includes('验证失败')) {
            if (!hasReplaced) {
                replaceFpValue();
            }
        }
    }

    function generateNewFp() {
        const chars = 'abcdef0123456789';
        let fp = '';

        for (let i = 0; i < 32; i++) {
            fp += chars.charAt(Math.floor(Math.random() * chars.length));
        }

        return fp.substring(0, 32);
    }

    // Rotate the fingerprint in every store the page reads from.
    function replaceFpValue() {
        const newFp = generateNewFp();

        try {
            localStorage.setItem('fp', newFp);
            localStorage.setItem('fingerprint', newFp);
            localStorage.setItem('device_fp', newFp);

            sessionStorage.setItem('fp', newFp);
            sessionStorage.setItem('fingerprint', newFp);
            sessionStorage.setItem('device_fp', newFp);

            document.cookie = `fp=${newFp}; path=/; max-age=86400`;
            document.cookie = `fingerprint=${newFp}; path=/; max-age=86400`;

            hasReplaced = true;

            chrome.runtime.sendMessage({action: 'logReset'});

            // Reload once so the page picks up the rotated fingerprint.
            if (autoRefresh) {
                setTimeout(() => {
                    location.reload();
                }, 3000);
            }
        } catch (e) {
        }
    }

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'toggle') {
            enabled = request.enabled;
            sendResponse({status: 'success'});
        } else if (request.action === 'getStatus') {
            sendResponse({
                enabled: enabled,
                autoRefresh: autoRefresh,
                currentFp: localStorage.getItem('fp'),
                pageUrl: location.href
            });
        } else if (request.action === 'autoRefresh') {
            autoRefresh = request.enabled;
            sendResponse({status: 'success'});
        } else if (request.action === 'manualReset') {
            hasReplaced = false;
            replaceFpValue();
            sendResponse({status: 'success'});
        }

        return true;
    });

    // Keep a handle on fetch so future hooks can intercept requests without
    // breaking callers that captured it earlier.
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
        const url = args[0];

        return originalFetch.apply(this, args);
    };

    // Prefer the rotated fingerprint whenever the page asks for one.
    if (window.getFingerprint) {
        const originalGetFingerprint = window.getFingerprint;
        window.getFingerprint = function() {
            if (enabled && hasReplaced) {
                const fp = localStorage.getItem('fp');

                if (fp && fp.length === 32) {
                    return fp;
                }
            }
            return originalGetFingerprint.apply(this, arguments);
        };
    }

    monitorUsage();
})();
