// Page-side wiring: reinject the content script after navigation, and the toolbar menu.
//
// Both only translate a browser event into one chrome call, so they stay separate from the relay
// modules that hold state.

export function registerInjection({ chrome, files, siteMatch }) {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (changeInfo.status !== 'complete' || !tab.url || !tab.url.includes(siteMatch)) return;

        chrome.scripting.executeScript({ target: { tabId }, files }).catch(() => {
            // Tabs closed mid-injection and pages that forbid scripting are not errors worth
            // surfacing: the content script also declares itself in the manifest.
        });
    });
}

// Creation belongs to the install event: calling it on every worker start duplicates the id.
export function createMenu({ chrome, id, title }) {
    chrome.contextMenus.create({ id, title, contexts: ['all'] });
}

export function registerMenuClick({ chrome, id, url }) {
    chrome.contextMenus.onClicked.addListener(info => {
        if (info.menuItemId !== id) return;
        chrome.tabs.create({ url });
    });
}
