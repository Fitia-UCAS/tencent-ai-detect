'use strict';

// The panel never asks the user to refresh. State arrives two ways and both are passive:
// the background writes every status report to storage, and the panel follows that key; when the
// user switches tabs the panel re-evaluates on its own. The initial read only exists to catch up
// on whatever happened before the panel opened.

const DETECT_HOST = 'matrix.tencent.com';

const LABELS = {
  waiting: 'Waiting…',
  idle: 'Ready',
  ok: 'Ready',
  quota: 'Quota reached',
  captcha: 'Verification needed',
  ambiguous: 'Check the page',
  'signed-in': 'Signed in',
  rotated: 'Rotated',
  'relay-offline': 'Relay offline',
  away: 'Open the detection page'
};

document.addEventListener('DOMContentLoaded', () => {
  const refreshSwitch = document.getElementById('toggle-refresh');
  const relaySwitch = document.getElementById('toggle-relay');
  const resetButton = document.getElementById('reset-usage');
  const openButton = document.getElementById('open-site');
  const stateValue = document.getElementById('page-state');
  const notice = document.getElementById('notice');
  const hostAlert = document.getElementById('host-alert');
  const hostAlertDetail = document.getElementById('host-alert-detail');
  let noticeTimer;

  const renderSwitch = (element, enabled) => {
    element.classList.toggle('active', enabled);
    element.setAttribute('aria-checked', String(enabled));
  };

  // Toast helper: re-showing a notice restarts the 2.2s dismiss timer.
  const showNotice = message => {
    if (noticeTimer) clearTimeout(noticeTimer);
    notice.textContent = message;
    notice.classList.add('show');
    noticeTimer = setTimeout(() => notice.classList.remove('show'), 2200);
  };

  // --- live page state -----------------------------------------------------

  const showState = (status, detail, remaining) => {
    const key = LABELS[status] ? status : 'idle';
    // The remaining count is the number the user actually wants; show it beside the state when
    // the page reports one, and leave the label alone when it does not.
    const suffix = Number.isInteger(remaining) ? ` · ${remaining} left` : '';
    stateValue.textContent = LABELS[key] + suffix;
    stateValue.dataset.state = key;
    stateValue.title = detail || '';
  };

  // A report from a tab that is not the detection page says nothing about what the user is
  // looking at now, so it is ignored rather than shown as the current state.
  const reportForCurrentTab = report => {
    if (!report) {
      showState('away');
      return;
    }
    showState(report.status || 'idle', report.signedIn ? 'Signed in' : '', report.remaining);
  };

  const readActiveTab = () => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const current = tabs[0];

      // Reading tabs requires no error handling here: an empty result is the normal answer when
      // no window is focused, and it means "nothing to report" rather than a failure.
      if (!current || !current.url || !current.url.includes(DETECT_HOST)) {
        showState('away');
        return;
      }

      chrome.tabs.sendMessage(current.id, { action: 'getStatus' }, response => {
        // A page that has not finished loading has no content script yet; the tab listeners will
        // ask again once it settles, so this is not surfaced as an error.
        if (chrome.runtime.lastError || !response) {
          showState('waiting');
          return;
        }
        reportForCurrentTab(response);
      });
    });
  };

  // Push path: the background stores each report, so following that key keeps the panel current
  // without polling.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.lastStatus) return;
    readActiveTab();
  });

  // Switching tabs or loading a page changes which tab the panel is describing.
  chrome.tabs.onActivated.addListener(() => readActiveTab());
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete' || !tab.active) return;
    readActiveTab();
  });

  // Also follow the relay's own liveness: a relay that dropped out is a distinct state from a
  // page that is merely idle.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.relayOnline) return;
    if (changes.relayOnline.newValue === false) showState('relay-offline');
  });

  readActiveTab();

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

  chrome.storage.local.get(['autoRefresh', 'relayEnabled', 'relayOnline'], state => {
    renderSwitch(refreshSwitch, state.autoRefresh !== false);
    renderSwitch(relaySwitch, state.relayEnabled !== false);
    if (state.relayOnline === false) showState('relay-offline');
  });

  // The relay switch controls whether the local relay runs at all. Turning it
  // off stops the process; the page falls back to its own socket.
  relaySwitch.addEventListener('click', () => {
    if (relaySwitch.disabled) return;

    const previous = relaySwitch.getAttribute('aria-checked') === 'true';
    const enabled = !previous;
    relaySwitch.disabled = true;
    renderSwitch(relaySwitch, enabled);

    chrome.runtime.sendMessage({ action: 'setRelay', enabled }, response => {
      // Consume lastError in the callback; otherwise a missing worker leaves
      // the control looking enabled despite no preference having been saved.
      const error = chrome.runtime.lastError;
      relaySwitch.disabled = false;
      if (error || !response || response.status !== 'success') {
        renderSwitch(relaySwitch, previous);
        showNotice('Could not change Relay setting');
        return;
      }

      renderSwitch(relaySwitch, enabled);
      showNotice(enabled
        ? (response.online ? 'Relay started' : 'Relay is starting…')
        : 'Relay stop requested');
    });
  });

  refreshSwitch.addEventListener('click', () => {
    if (refreshSwitch.disabled) return;

    const previous = refreshSwitch.getAttribute('aria-checked') === 'true';
    const autoRefresh = !previous;
    refreshSwitch.disabled = true;
    renderSwitch(refreshSwitch, autoRefresh);

    chrome.storage.local.set({ autoRefresh }, () => {
      const error = chrome.runtime.lastError;
      refreshSwitch.disabled = false;
      if (error) {
        renderSwitch(refreshSwitch, previous);
        showNotice('Could not save Auto refresh setting');
      }
    });
  });

  openButton.addEventListener('click', () => {
    chrome.tabs.create({
      url: 'https://matrix.tencent.com/ai-detect/',
      active: true
    });
  });

  resetButton.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const current = tabs[0];
      if (!current || !current.id) {
        showNotice('Open the AI detection page first');
        return;
      }

      // Guard against double clicks while the message round-trip is in flight.
      resetButton.disabled = true;
      chrome.tabs.sendMessage(current.id, { action: 'manualReset' }, () => {
        resetButton.disabled = false;
        if (chrome.runtime.lastError) {
          showNotice('Open the AI detection page first');
          return;
        }
        showNotice('Sent to the current page');
      });

      // resetCount and resetHistory are owned by the background process.
      // The content script reports logReset only after the reset operation
      // actually proceeds. Incrementing here as well double-counted manual
      // resets (and counted attempts that never reached the reset path).
    });
  });
});
