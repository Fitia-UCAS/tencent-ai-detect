'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const refreshSwitch = document.getElementById('toggle-refresh');
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

  chrome.storage.local.get(['autoRefresh'], state => {
    renderSwitch(refreshSwitch, state.autoRefresh !== false);
  });

  refreshSwitch.addEventListener('click', () => {
    const autoRefresh = refreshSwitch.getAttribute('aria-checked') !== 'true';
    renderSwitch(refreshSwitch, autoRefresh);
    chrome.storage.local.set({ autoRefresh });
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

      chrome.storage.local.get(['resetCount'], result => {
        chrome.storage.local.set({
          resetCount: (result.resetCount || 0) + 1,
          lastResetTime: Date.now()
        });
      });
    });
  });
});
