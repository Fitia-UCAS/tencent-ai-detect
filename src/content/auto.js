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
        // Keep the original text, including leading/trailing whitespace. readEditor() trims for
        // button gating, but a saved draft must faithfully preserve what the user entered.
        const editor = document.querySelector(EDITOR_SELECTOR);
        const text = editor ? (editor.textContent || '') : '';
        if (!text.trim()) return false;

        try {
            localStorage.setItem(DRAFT_KEY, text);
        } catch (e) {
            // Storage blocked: the reload still happens, only the draft is lost.
            return false;
        }

        return true;
    };

    // A populated editor wins over a stored backup for the entire page load. Otherwise, clearing
    // newer text could unexpectedly resurrect an older draft on a later timer tick.
    let draftRestoreConflict = false;

    // Puts the draft back after a reload, then forgets it so a later visit does not resurrect text
    // the user already moved on from.
    ZQ.restoreDraft = function () {
        if (draftRestoreConflict) return false;
        let text = null;

        try {
            text = localStorage.getItem(DRAFT_KEY);
        } catch (e) {
            return false;
        }

        if (!text) return false;

        // At document_start the site's editor may not exist yet. Keep the draft until it does.
        // Likewise, do not overwrite text the user has already entered after the reload.
        const editor = document.querySelector(EDITOR_SELECTOR);
        if (!editor) return false;
        if ((editor.textContent || '').trim()) {
            draftRestoreConflict = true;
            return false;
        }

        try {
            if (!ZQ.writeEditor(text)) return false;
            // A synchronous page input listener can reject/reset the change without throwing.
            // In that case retain the draft for a later recovery attempt.
            if (!(editor.textContent || '').trim()) return false;
        } catch (e) {
            return false;
        }

        // Only discard the backup after the editor accepted a non-empty value.
        // A storage error does not mean the editor write itself failed.
        try {
            localStorage.removeItem(DRAFT_KEY);
        } catch (e) {
        }
        return true;
    };

    // Compares on the text with all whitespace removed.
    //
    // The site's editor normalises line breaks and spacing as it renders, so the text read back
    // after a reload is rarely byte-identical to what was saved. A strict comparison therefore
    // treated a restored draft as brand-new text, pressed detect again, and produced a detection
    // with no captcha ticket - which the server answers with "Invalid request". That is the loop
    // this normalisation closes.
    //
    // It is a deliberately loose fingerprint for suppressing repeat submissions, not an identity
    // for the text: "a b" and "ab" collapse together. Skipping the second one costs nothing (the
    // site judges meaning, and a space does not change it), while treating a re-rendered draft as
    // new text costs a request the server is guaranteed to refuse.
    function fingerprint(text) {
        return String(text || '').replace(/\s+/g, '');
    }

    // What the last automatic click did with the text it ran on.
    //
    // A click is not a completed detection, and the site offers no event that says "the server
    // accepted this". So the record carries the state the click left behind, and never claims more
    // than was observed:
    //
    //   submitted-unconfirmed  pressed; nothing on the page has settled it yet
    //   completed              the site's own counter fell, so one detection was charged
    //   blocked                the page shows the server's refusal; pressing again would send the
    //                          same doomed request
    //   unknown                a value written by an older build as a bare fingerprint
    //
    // None of these permit an automatic re-press. A refusal cannot be retried into a success - the
    // ticket is gone - and an unconfirmed press cannot be told apart from a slow one. That is why
    // there is no retry here at all: the cost of guessing wrong is a request the server refuses.
    const ATTEMPT_KEY = LAST_DETECTED_KEY;

    function readAttempt() {
        let raw = null;

        try {
            raw = localStorage.getItem(ATTEMPT_KEY);
        } catch (e) {
            return null;
        }

        if (!raw) return null;

        // A bare fingerprint from an older build. Read as settled, so an upgrade cannot turn text
        // that was already submitted into a fresh, ticket-less click.
        if (raw.charAt(0) !== '{') return { f: raw, s: 'unknown', a: 1, t: 0, q: null };

        try {
            const parsed = JSON.parse(raw);
            return {
                f: String(parsed.f || ''),
                s: String(parsed.s || 'unknown'),
                a: Number(parsed.a) || 1,
                t: Number(parsed.t) || 0,
                q: typeof parsed.q === 'number' ? parsed.q : null
            };
        } catch (e) {
            return null;
        }
    }

    function writeAttempt(attempt) {
        try {
            localStorage.setItem(ATTEMPT_KEY, JSON.stringify(attempt));
        } catch (e) {
        }
    }

    function currentQuota() {
        if (typeof ZQ.readQuota !== 'function') return null;

        try {
            const quota = ZQ.readQuota();
            return quota && typeof quota.remaining === 'number' ? quota.remaining : null;
        } catch (e) {
            return null;
        }
    }

    // Records whatever settled since the press. Only two outcomes are observable from the page: the
    // refusal wording, and a counter that fell because a detection was charged.
    function settleAttempt() {
        const attempt = readAttempt();
        if (!attempt || attempt.s !== 'submitted-unconfirmed') return attempt;

        let settled = null;

        if (typeof ZQ.pageState === 'function' && ZQ.pageState() === 'ambiguous') {
            settled = 'blocked';
        } else {
            const quota = currentQuota();
            if (attempt.q !== null && quota !== null && quota < attempt.q) settled = 'completed';
        }

        if (!settled) return attempt;

        const next = { ...attempt, s: settled };
        writeAttempt(next);
        return next;
    }

    // The state recorded for the text in the editor, for the panel and for tests.
    ZQ.attemptState = function () {
        const attempt = settleAttempt();
        const text = ZQ.readEditor();
        if (!attempt || attempt.f !== fingerprint(text)) return 'idle';
        return attempt.s;
    };

    // Clicks only when there is something to detect, the control is ready, and this text has not
    // already had its press.
    ZQ.autoDetect = function () {
        if (!ZQ.state.enabled || !ZQ.state.autoRefresh || ZQ.state.rotating) return false;

        // The challenge belongs to the user. Clicking behind it would also be refused.
        if (ZQ.captchaOpen()) return false;

        const text = ZQ.readEditor();
        if (!text) return false;

        // A refused rule means the ticket will be issued for the real address while the socket
        // carries the synthetic one, and the server refuses that pairing every time. Sending anyway
        // would spend the press on a request that cannot succeed. Unconfirmed (null) still goes
        // ahead: the install is usually just slower than the first tick.
        if (ZQ.state.identityConfirmed === false) return false;

        const print = fingerprint(text);
        const previous = settleAttempt();

        // Any recorded state for this text means it has had its press. See the note above on why
        // none of them is retried.
        if (previous && previous.f === print) return false;

        const button = ZQ.detectButton();
        if (!button || button.disabled) return false;

        // Recorded before the click, because the click can start a page change that removes the
        // editor. The interval must not come back to the same text while the request is in flight.
        writeAttempt({
            f: print,
            s: 'submitted-unconfirmed',
            a: 1,
            t: Date.now(),
            q: currentQuota()
        });
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
