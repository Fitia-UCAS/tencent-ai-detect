'use strict';

// The panel never asks the user to refresh. State arrives two ways and both are passive:
// the background writes every status report to storage, and the panel follows that key; when the
// user switches tabs the panel re-evaluates on its own. The initial read only exists to catch up
// on whatever happened before the panel opened.

const DETECT_HOST = 'matrix.tencent.com';

document.addEventListener('DOMContentLoaded', () => {
    const hostAlert = document.getElementById('host-alert');
    const hostAlertDetail = document.getElementById('host-alert-detail');

    // --- live page state -----------------------------------------------------

    // The page state row is gone, and so is the polling that fed it.
    //
    // It was the one part of this panel that had to be right at the instant the panel was open, and it
    // could not be: the value arrives when the content script reports, so a panel opened afterwards
    // showed whatever had been written last, or nothing. A field that is usually stale is worse than
    // no field - it invites you to trust it. The same reports still go to storage and to the trail,
    // where each one carries its timestamp and can be read back in order.

    // There is no toast, no notice line and no floating anything. The panel used to raise a box over
    // the content to say what had just been chosen - a box that covered what you were looking at, to
    // describe what you had just pressed. A second attempt put the same sentence in a line along the
    // bottom, which was the same mistake in a quieter shape: a strip that exists only to narrate the
    // click you just made. Both are gone. What the panel needs to say, it says in place - the chosen
    // card marks itself, the wait card carries its own seconds, and a relay that is down shows the
    // host alert. Nothing else needs narrating.

    // --- native host health --------------------------------------------------

    // A host that never started looks exactly like an idle extension: the switches render, the panel
    // is calm, and nothing works. The browser reports it as a bare disconnect, so the reason is
    // carried here and turned into an instruction.
    const renderHostAlert = hostError => {
        if (!hostAlert) return;
        if (!hostError) {
            hostAlert.hidden = true;
            return;
        }
        if (hostAlertDetail) hostAlertDetail.textContent = hostError;
        hostAlert.hidden = false;
    };

    chrome.storage.local.get(['hostError', 'relayOnline'], state => {
        // A registered host clears its own error on first message, so a stale value must not outlive
        // that. Only show the banner while the relay is also down.
        if (state.relayOnline === true) return;
        renderHostAlert(state.hostError);
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (!changes.hostError && !changes.relayOnline) return;

        chrome.storage.local.get(['hostError', 'relayOnline'], state => {
            renderHostAlert(state.relayOnline === true ? null : state.hostError);
        });
    });


    // --- controls ------------------------------------------------------------

    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
        chrome.sidePanel
            .setPanelBehavior({ openPanelOnActionClick: true })
            .catch(() => {});
    }

    // A missing element here would throw on addEventListener and take the whole panel down with it,
    // leaving a blank window and no clue why. Each control is bound only if it is in the document.
    const bind = (element, event, handler) => {
        if (!element) return;
        element.addEventListener(event, handler);
    };

    const spentDelay = document.getElementById('spent-delay');
    const spentDelayHint = document.getElementById('spent-delay-hint');
    const rotateButton = document.getElementById('rotate-now');
    const spentCards = Array.from(document.querySelectorAll('.spent-card'));

    // Swapping an address is only possible on a page that has one. The button used to carry a
    // `disabled` attribute in the markup with nothing that ever removed it, so it could never be
    // pressed; now it is enabled exactly when the current tab is the detection page.
    const syncRotateButton = () => {
        if (!rotateButton) return;
        chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
            const current = tabs[0];
            const onPage = Boolean(current && current.url && current.url.includes(DETECT_HOST));
            rotateButton.disabled = !onPage;
        });
    };

    syncRotateButton();

    // The panel stays open while tabs change, so the button has to follow: leaving it enabled on a
    // page with no address would send a request nothing answers.
    chrome.tabs.onActivated.addListener(syncRotateButton);
    chrome.tabs.onUpdated.addListener((tabId, info) => {
        if (info.url || info.status === 'complete') syncRotateButton();
    });

    // Exactly one card is chosen. The mark goes on the card, because the left edge is drawn there;
    // rendering the whole group from the stored value means the panel cannot drift into a state where
    // two cards look selected or none does.
    const renderSpentMode = mode => {
        for (const card of spentCards) {
            card.dataset.selected = String(card.dataset.mode === mode);
        }
    };

    chrome.storage.local.get(
        ['autoRefresh', 'relayOnline', 'spentMode', 'spentDelaySeconds'],
        state => {
            const seconds = Number.isFinite(state.spentDelaySeconds) ? state.spentDelaySeconds : 30;
            const mode = state.spentMode || 'manual';

            renderSpentMode(mode);
            if (spentDelay) spentDelay.value = String(seconds);
            if (spentDelayHint) spentDelayHint.textContent = 'Swaps after ' + seconds + 's';
        });

    // The panel owns the preference; the content script reads it when the address runs out, so the
    // decision lives in one place instead of being duplicated into each trigger.
    //
    // Clicking the header chooses the card. On the one card that opens, the same click also toggles
    // it, because <details> does that itself: choosing it and seeing its setting are one gesture.
    for (const card of spentCards) {
        const head = card.querySelector('.spent-head');
        if (!head) continue;

        head.addEventListener('click', () => {
            const spentMode = card.dataset.mode;
            renderSpentMode(spentMode);

            chrome.storage.local.set({ spentMode });
        });
    }

    // Changed rather than typed: committing on every keystroke would store 3, 30, 300 while someone
    // types 300 and act on each. A wait can be a fraction - half a second is a real answer for a page
    // that finishes fast - so the value is kept as typed rather than rounded to whole seconds.
    bind(spentDelay, 'change', () => {
        const seconds = Math.min(3600, Math.max(0.5, Number(spentDelay.value) || 30));
        // Two decimals is enough to express any useful wait and keeps the field readable.
        const rounded = Math.round(seconds * 100) / 100;
        spentDelay.value = String(rounded);
        // The card's own subtitle carries the number, so leaving it stale would have the list describe
        // a wait that is no longer the one stored.
        if (spentDelayHint) spentDelayHint.textContent = 'Swaps after ' + rounded + 's';
        chrome.storage.local.set({ spentDelaySeconds: rounded });
    });

    // Asking for another detection is the moment the address should change: the press could not be
    // served otherwise, and waiting longer only leaves the page unusable.
    bind(rotateButton, 'click', () => {
        chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
            const current = tabs[0];
            if (!current || !current.url || !current.url.includes(DETECT_HOST)) return;

            rotateButton.disabled = true;
            chrome.tabs.sendMessage(current.id, { action: 'rotateNow' }, response => {
                // Read lastError so a page without a content script does not leave the control looking
                // busy forever. There is nothing else to do about it: a failure here means the page is
                // not open or has no content script, both of which the user can see for themselves.
                void chrome.runtime.lastError;
                syncRotateButton();
            });
        });
    });

    // The auto refresh switch is gone. What it controlled is now decided by the four rows above:
    // "Wait for me" holds the page, the other three swap on their own schedule, and "Swap now" is the
    // eager end that the switch used to be. Two controls for one decision meant the switch could
    // silently contradict the row that was selected.

    // The way into the detection page is a link in the corner now, so the browser opens it and the
    // script does not have to. `target="_blank"` in the markup keeps the panel itself in place.

});
