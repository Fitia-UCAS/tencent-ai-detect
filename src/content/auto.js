// Driving the site without the user touching it.
//
// Everything else in this extension maintains the allowance; none of it starts a detection. The
// user still had to paste text and press 立即检测 for every run, which is the part that made the
// flow feel manual no matter how well the rotation worked.
//
// Two things stand in the way of automating that, and both are handled here:
//
//   1. The editor is a contenteditable block, not a textarea, so its value cannot be read or set
//      with .value. Its text is taken from textContent and written back with a real InputEvent,
//      because the site's own listeners only react to the event.
//   2. A rotation reloads the page, which throws the pasted text away. The draft is saved before
//      the reload and put back afterwards, so a run survives the rotation that keeps it alive.
//
// Nothing here clicks while a captcha is on screen: answering the challenge is the one step that
// stays with the user, and a click behind the overlay would start a detection the challenge was
// blocking.

(function () {
    'use strict';

    if (window.__zqDetectReady) return;

    const ZQ = (window.__zq = window.__zq || {});

    const DRAFT_KEY = 'zqDraft';
    // The text the last automatic click ran on. Comparing against it is what stops the interval
    // from firing a detection every tick on the same text.
    const LAST_DETECTED_KEY = 'zqLastDetected';

    // The editor is a contenteditable block; the class names are the site's own fallbacks, kept in
    // the same order the e2e test uses so one change does not silently diverge from the other.
    const EDITOR_SELECTOR = '[contenteditable="true"], .editor, [class*="editor"]';

    ZQ.readEditor = function () {
        const editor = document.querySelector(EDITOR_SELECTOR);
        return editor ? (editor.textContent || '').trim() : '';
    };

    // Returns the site's detect control, preferring the one that states the remaining count.
    ZQ.detectButton = function () {
        const buttons = Array.from(document.querySelectorAll('button'));

        return buttons.find(button => (button.textContent || '').includes('立即检测')) ||
            buttons.find(button => (button.textContent || '').includes('检测')) ||
            null;
    };

    ZQ.writeEditor = function (text) {
        const editor = document.querySelector(EDITOR_SELECTOR);
        if (!editor) return false;

        editor.focus();
        editor.textContent = text;
        // The site reads its own input events; assigning textContent alone leaves its state empty.
        editor.dispatchEvent(new InputEvent('input', { bubbles: true }));

        return true;
    };

    ZQ.saveDraft = function () {
        const text = ZQ.readEditor();
        if (!text) return false;

        try {
            localStorage.setItem(DRAFT_KEY, text);
        } catch (e) {
            // Storage blocked: the reload still happens, only the draft is lost.
            return false;
        }

        return true;
    };

    // Puts the draft back after a reload, then forgets it so a later visit does not resurrect text
    // the user already moved on from.
    ZQ.restoreDraft = function () {
        let text = null;

        try {
            text = localStorage.getItem(DRAFT_KEY);
        } catch (e) {
            return false;
        }

        if (!text) return false;

        try {
            localStorage.removeItem(DRAFT_KEY);
        } catch (e) {
        }

        // The editor only exists once the page has rendered its own bundle.
        return ZQ.writeEditor(text);
    };

    function lastDetected() {
        try {
            return localStorage.getItem(LAST_DETECTED_KEY) || '';
        } catch (e) {
            return '';
        }
    }

    // Compares on the text with all whitespace removed.
    //
    // The site's editor normalises line breaks and spacing as it renders, so the text read back
    // after a reload is rarely byte-identical to what was saved. A strict comparison therefore
    // treated a restored draft as brand-new text, pressed detect again, and produced a detection
    // with no captcha ticket - which the server answers with "Invalid request". That is the loop
    // this normalisation closes.
    function fingerprint(text) {
        return String(text || '').replace(/\s+/g, '');
    }

    function rememberDetected(text) {
        try {
            localStorage.setItem(LAST_DETECTED_KEY, fingerprint(text));
        } catch (e) {
        }
    }

    // Clicks only when there is something to detect, the control is ready, and this exact text has
    // not already been run.
    ZQ.autoDetect = function () {
        if (!ZQ.state.enabled || !ZQ.state.autoRefresh || ZQ.state.rotating) return false;

        // The challenge belongs to the user. Clicking behind it would also be refused.
        if (ZQ.captchaOpen()) return false;

        const text = ZQ.readEditor();
        if (!text) return false;
        if (fingerprint(text) === lastDetected()) return false;

        const button = ZQ.detectButton();
        if (!button || button.disabled) return false;

        rememberDetected(text);
        button.click();

        return true;
    };

    // The editor appears after the page's own bundle runs, and the draft can only be restored once
    // it exists, so the first pass waits for it instead of assuming readiness.
    const AUTO_MS = 1500;

    let autoTimer = null;

    ZQ.startAuto = function (intervalMs) {
        const stop = () => {
            if (autoTimer) clearInterval(autoTimer);
            autoTimer = null;
        };

        let restored = false;

        const tick = () => {
            if (!ZQ.state.contextAlive) {
                stop();
                return;
            }

            if (!ZQ.state.enabled || !ZQ.state.autoRefresh) return;

            if (!restored) {
                restored = ZQ.restoreDraft();

                // The restored text is new to the page, so the click has to happen after it lands.
                if (restored) return;
            }

            ZQ.autoDetect();
        };

        stop();
        autoTimer = setInterval(tick, intervalMs || AUTO_MS);
        // One immediate pass so an already-filled page is not left waiting for the first interval.
        tick();

        return stop;
    };

    ZQ.stopAuto = function () {
        if (autoTimer) clearInterval(autoTimer);
        autoTimer = null;
    };
})();
