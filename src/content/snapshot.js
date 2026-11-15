// A DOM snapshot of the parts of the page that explain a detection, taken at a named moment.
//
// The trail records what this extension did; it cannot say what the page showed. "Invalid request"
// is a string in the page, and whether it sits in a result panel, an error toast, or a leftover from
// an earlier attempt is the whole difference between a refusal and a stale view. So the trail also
// carries a small, structured picture of the page at the moments that matter.
//
// The full document is megabytes and mostly irrelevant, and storing it would also store the text the
// user pasted. What is kept instead is: the phrases that classify the page, the elements that contain
// them with their tag/id/class/visibility, the challenge container's geometry, and whether a result
// panel looks present. That is what distinguishes "no result yet" from "result replaced".
(function () {
    'use strict';

    if (window.__zqSnapshotReady) return;

    const ZQ = (window.__zq = window.__zq || {});

    // Wording worth capturing. These are the page's own strings plus the markers this extension
    // treats as state, so a snapshot and pageState() always describe the same things.
    const MARKERS = [
        'Invalid request',
        '验证失败',
        '请完成验证',
        '请先完成验证',
        '今日剩余',
        '剩余',
        'AI 生成',
        '人工创作'
    ];

    const MAX_ELEMENTS = 12;
    const MAX_TEXT = 220;

    function describe(element) {
        if (!element || !element.tagName) return null;

        let visible = true;
        try {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);
            visible = rect.width > 0 && rect.height > 0 &&
                style.display !== 'none' && style.visibility !== 'hidden' &&
                Number(style.opacity) !== 0;
        } catch (e) {
            visible = null;
        }

        return {
            tag: element.tagName.toLowerCase(),
            id: element.id || null,
            cls: typeof element.className === 'string' ? element.className.slice(0, 80) : null,
            visible,
            text: String(element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
        };
    }

    // Every element whose own text carries a marker, reported once per marker. A marker's container is
    // what tells a result panel apart from a toast: the panel has the site's result classes, the toast
    // is a short-lived node near the cursor.
    function findContaining(text, marker) {
        const hits = [];
        const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);

        for (let node = walker.currentNode; node; node = walker.nextNode()) {
            if (hits.length >= MAX_ELEMENTS) break;

            const own = node.childNodes
                ? Array.from(node.childNodes)
                    .filter(child => child.nodeType === 3)
                    .map(child => child.nodeValue)
                    .join(' ')
                : '';

            if (!own || !own.includes(marker)) continue;
            hits.push(describe(node));
        }

        return hits;
    }

    function challengeGeometry() {
        const element = document.getElementById('tcaptcha_iframe_dy') ||
            document.getElementById('tcaptcha_iframe') ||
            document.getElementById('tcaptcha_transform') ||
            document.getElementById('tcaptcha_wrapper_transform_dy') ||
            document.querySelector('.tcaptcha-transform');

        if (!element) return null;

        try {
            const rect = element.getBoundingClientRect();
            const style = window.getComputedStyle(element);

            return {
                id: element.id || null,
                w: Math.round(rect.width),
                h: Math.round(rect.height),
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                opacity: style.opacity,
                display: style.display,
                // What captchaOpen() itself would conclude, so a disagreement is visible.
                open: typeof ZQ.captchaOpen === 'function' ? ZQ.captchaOpen() : null
            };
        } catch (e) {
            return { error: String(e && e.message ? e.message : e) };
        }
    }

    // A short fingerprint of the result area: how many nodes carry the site's result wording, and the
    // first line of each. Comparing two snapshots shows whether the result changed or merely remained.
    function resultShape() {
        const markers = {};
        const text = document.body ? (document.body.innerText || '') : '';

        for (const marker of MARKERS) {
            if (!text.includes(marker)) continue;
            markers[marker] = findContaining(text, marker);
        }

        return markers;
    }

    ZQ.snapshot = function snapshot(label) {
        try {
            return {
                label: String(label),
                url: String(location.href).slice(0, 120),
                readyState: document.readyState,
                bodyLen: document.body ? (document.body.innerText || '').length : 0,
                state: typeof ZQ.pageState === 'function' ? ZQ.pageState() : null,
                quota: typeof ZQ.readQuota === 'function' ? ZQ.readQuota() : null,
                challenge: challengeGeometry(),
                markers: resultShape()
            };
        } catch (e) {
            return { label: String(label), error: String(e && e.message ? e.message : e) };
        }
    };

    window.__zqSnapshotReady = true;
})();
