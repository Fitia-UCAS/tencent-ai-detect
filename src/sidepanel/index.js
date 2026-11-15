'use strict';

// The side panel: four answers to "what happens once the address is used up", and the one control
// that swaps the address on demand.
//
// The panel owns the preference and the content script reads it when the address runs out, so the
// decision exists here and nowhere else.

const DETECT_HOST = 'matrix.tencent.com';

// Only the detection page has an address to swap. Every control that depends on that asks this one
// question, so the answer cannot drift between them.
const isDetectionPage = url => typeof url === 'string' && url.includes(DETECT_HOST);

document.addEventListener('DOMContentLoaded', () => {
    const hostAlert = document.getElementById('host-alert');
    const hostAlertDetail = document.getElementById('host-alert-detail');
    const spentDelay = document.getElementById('spent-delay');
    const spentDelayHint = document.getElementById('spent-delay-hint');
    const rotateButton = document.getElementById('rotate-now');
    const spentCards = Array.from(document.querySelectorAll('.spent-card'));

    // A control missing from the document would throw on addEventListener and leave the panel blank
    // with no clue why, so every binding goes through here.
    const bind = (element, event, handler) => {
        if (!element) return;
        element.addEventListener(event, handler);
    };

    // --- host health ---

    // A host that never started looks exactly like an idle extension: the panel renders, the cards
    // respond, and every detection fails. The alert carries the reason and the command that fixes it.
    // It stays silent while the relay is up, because a registered host clears its own error on the
    // first message and a stale value must not outlive that.
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

    // --- the four answers ---

    // The mark lives on the card because the left edge is drawn there. Rendering the whole group from
    // one stored value keeps the panel from drifting into a state where two cards look chosen, or none.
    const renderSpentMode = mode => {
        for (const card of spentCards) {
            card.dataset.selected = String(card.dataset.mode === mode);
        }
    };

    chrome.storage.local.get(['spentMode', 'spentDelaySeconds'], state => {
        const seconds = Number.isFinite(state.spentDelaySeconds) ? state.spentDelaySeconds : 30;
        renderSpentMode(state.spentMode || 'manual');
        if (spentDelay) spentDelay.value = String(seconds);
        if (spentDelayHint) spentDelayHint.textContent = 'Swaps after ' + seconds + 's';
    });

    // Clicking a header chooses the card. On the wait card the same click also opens it, because
    // <details> does that itself: choosing it and setting its wait are one gesture.
    for (const card of spentCards) {
        const head = card.querySelector('.spent-head');
        if (!head) continue;

        bind(head, 'click', () => {
            const spentMode = card.dataset.mode;
            renderSpentMode(spentMode);
            chrome.storage.local.set({ spentMode });
        });
    }

    // A wait can be a fraction: half a second is a real answer for a page that finishes fast. Two
    // decimals express any useful wait and keep the field readable. Committed on change rather than on
    // every keystroke, which would store 3, 30, 300 while someone types 300.
    bind(spentDelay, 'change', () => {
        const seconds = Math.min(3600, Math.max(0.5, Number(spentDelay.value) || 30));
        const rounded = Math.round(seconds * 100) / 100;
        spentDelay.value = String(rounded);
        if (spentDelayHint) spentDelayHint.textContent = 'Swaps after ' + rounded + 's';
        chrome.storage.local.set({ spentDelaySeconds: rounded });
    });

    // --- swapping on demand ---

    // The control follows the current tab: usable exactly where there is an address to swap. The panel
    // stays open across tab switches, so this has to be re-asked on every change.
    const syncRotateButton = () => {
        if (!rotateButton) return;
        chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
            rotateButton.disabled = !isDetectionPage(tabs[0] && tabs[0].url);
        });
    };

    syncRotateButton();
    chrome.tabs.onActivated.addListener(syncRotateButton);
    chrome.tabs.onUpdated.addListener((tabId, info) => {
        if (info.url || info.status === 'complete') syncRotateButton();
    });

    // Asking for another detection is the moment the address should change: the press could not be
    // served otherwise, and waiting longer only leaves the page unusable.
    bind(rotateButton, 'click', () => {
        chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
            const current = tabs[0];
            if (!current || !isDetectionPage(current.url)) return;

            rotateButton.disabled = true;
            chrome.tabs.sendMessage(current.id, { action: 'rotateNow' }, () => {
                // Read lastError so a page without a content script cannot leave the control busy.
                void chrome.runtime.lastError;
                syncRotateButton();
            });
        });
    });

    // The toolbar icon opens this panel rather than a popup.
    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
        chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    }
});
