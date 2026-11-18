// The site's detect control.
//
// This file used to drive the page: a timer pressed detect, remembered which text had been asked,
// and saved and restored a draft across reloads. That is gone. An automatic press is not a user
// gesture, and the captcha answers it with a quick pass whose ticket the server refuses against a
// synthetic socket address; the press belongs to the person. The draft is gone with it: the site
// re-renders the editor, and a restore that cannot be faithful is not worth pretending about.
//
// What remains is the one lookup detection.js needs: the detect control, found by its wording.
(function () {
    'use strict';

    if (window.__zqDetectReady) return;

    const ZQ = (window.__zq = window.__zq || {});

    // Returns the site's detect control, preferring the one that states the remaining count.
    ZQ.detectButton = function detectButton() {
        const buttons = Array.from(document.querySelectorAll('button'));

        return buttons.find(button => (button.textContent || '').includes('立即检测')) ||
            buttons.find(button => (button.textContent || '').includes('检测')) ||
            null;
    };
})();
