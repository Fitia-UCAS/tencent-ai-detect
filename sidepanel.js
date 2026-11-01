'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const refreshSwitch = document.getElementById('toggle-refresh');
  const relaySwitch = document.getElementById('toggle-relay');
  const resetButton = document.getElementById('reset-usage');
  const openButton = document.getElementById('open-site');
  const notice = document.getElementById('notice');
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

  // Open the side panel when the toolbar icon is clicked (Chrome 116+).
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => {});
  }

  chrome.storage.local.get(['autoRefresh', 'relayEnabled'], state => {
    renderSwitch(refreshSwitch, state.autoRefresh !== false);
    renderSwitch(relaySwitch, state.relayEnabled !== false);
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
      if (!current?.id) {
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
