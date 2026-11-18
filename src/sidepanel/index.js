'use strict';

// The side panel: three answers to "what happens once the address is used up", and the one control
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
    const spentDelayWarning = document.getElementById('spent-delay-warning');
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

    // --- the three answers ---

    // The mark lives on the card because the left edge is drawn there. Rendering the whole group from
    // one stored value keeps the panel from drifting into a state where two cards look chosen, or none.
    //
    // The chosen cards that carry a setting also open. Measured: a stored zero showed "Swaps at once" in
    // the summary while the sentence explaining why that is the risky setting sat collapsed underneath
    // it - visible to the DOM, invisible to the person choosing.
    const renderSpentMode = mode => {
        for (const card of spentCards) {
            const chosen = card.dataset.mode === mode;
            card.dataset.selected = String(chosen);
            if (chosen && card.tagName === 'DETAILS') card.open = true;
        }
    };

    // A wait of zero is a legal answer, and it is the one that costs something: the page reloads the
    // moment the allowance runs out, and a reload that fast is what leaves a fresh page's socket and
    // its captcha ticket disagreeing about the address. Said here, once, in the card that owns the
    // number - the panel warns, it does not refuse, because the choice is the user's.
    const renderSpentDelay = seconds => {
        const value = String(seconds);
        if (spentDelay) spentDelay.value = value;
        if (spentDelayHint) {
            spentDelayHint.textContent = seconds === 0
                ? 'Swaps at once'
                : 'Swaps after ' + value + 's';
        }
        if (spentDelayWarning) spentDelayWarning.hidden = seconds !== 0;
    };

    // The field is a tenth of a second: finer than that cannot be observed, and coarser is the
    // difference between "immediately" and "a moment", which is the distinction this setting exists for.
    const WAIT_STEP = 0.1;
    const DEFAULT_WAIT_SECONDS = 2;

    const clampWait = raw => {
        // Number('') is 0, which would read as an emptied field meaning "swap at once" - the very
        // answer that costs something. Absence falls back instead.
        if (raw === '' || raw === null || raw === undefined) return DEFAULT_WAIT_SECONDS;

        const seconds = Number(raw);
        if (!Number.isFinite(seconds)) return DEFAULT_WAIT_SECONDS;

        // Rounded in tenths rather than by multiplying by the step: 1.23 * 10 / 0.1 lands on
        // 1.2000000000000002, and a stored value like that reaches the page as a wait nobody asked for.
        const stepped = Math.round(seconds * 10) / 10;

        return Math.min(3600, Math.max(0, stepped));
    };

    chrome.storage.local.get(['spentMode', 'spentDelaySeconds'], state => {
        const legacyImmediate = state.spentMode === 'immediate';
        const seconds = legacyImmediate ? 0 : clampWait(state.spentDelaySeconds);

        // The removed mode meant a zero wait. Normalize both stored fields together so the panel
        // and content script resolve the same setting even when the old profile had a stale delay.
        renderSpentMode(legacyImmediate ? 'delay' : (state.spentMode || 'manual'));
        renderSpentDelay(seconds);

        if (legacyImmediate) {
            chrome.storage.local.set({ spentMode: 'delay', spentDelaySeconds: 0 });
        }
    });

    // Clicking a header chooses the card. On the wait card the same click also opens it, because
    // choosing it and setting its wait are one gesture.
    //
    // That open is asked for here rather than left to the click, because the header of the wait card is
    // also its <summary>: the element toggles itself as the click's default action, which happens after
    // this handler has run. Measured: choosing the wait card closed it again in the same click, so the
    // setting it owns was never on screen. The default is therefore taken over - once, in one place.
    for (const card of spentCards) {
        const head = card.querySelector('.spent-head');
        if (!head) continue;

        bind(head, 'click', event => {
            const spentMode = card.dataset.mode;
            const wasChosen = card.dataset.selected === 'true';

            renderSpentMode(spentMode);
            chrome.storage.local.set({ spentMode });

            if (card.tagName === 'DETAILS') {
                event.preventDefault();
                // A newly chosen card opens; the card already chosen toggles, so a click can also put
                // the list back the way it was.
                card.open = wasChosen ? !card.open : true;
            }
        });
    }

    // Committed on change rather than on every keystroke, which would store 3, 30, 300 while someone
    // types 300. Rounded to the step the field advertises, so what is stored is what was asked for.
    bind(spentDelay, 'change', () => {
        const seconds = clampWait(spentDelay.value);
        renderSpentDelay(seconds);
        chrome.storage.local.set({ spentDelaySeconds: seconds });
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
