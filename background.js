(function() {
    'use strict';

    // Identity helper kept from the original bundle; safe to pass through.
    const _0x = function(str) {
        return str;
    };

    // Seed default state on first install / update.
    chrome.runtime.onInstalled.addListener(() => {
        chrome.storage.local.set({
            enabled: true,
            autoRefresh: true,
            resetCount: 0,
            resetHistory: [],
            ipUsageCount: 0,
            lastResetTime: Date.now()
        });
    });

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        // Append a reset event to the capped history log (keep the newest 100).
        if (request.action === 'logReset') {
            chrome.storage.local.get(['resetCount', 'resetHistory'], (result) => {
                const resetCount = (result.resetCount || 0) + 1;
                const resetHistory = result.resetHistory || [];

                resetHistory.push({
                    time: Date.now(),
                    tabId: sender?.tab?.id,
                    url: sender?.tab?.url
                });

                if (resetHistory.length > 100) {
                    resetHistory.shift();
                }

                chrome.storage.local.set({
                    resetCount: resetCount,
                    resetHistory: resetHistory,
                    lastResetTime: Date.now()
                });
            });

            sendResponse({status: 'success'});
        }

        // Count a usage hit; only accept it from the target site.
        if (request.action === 'usageIncrement') {
            if (!sender.tab || !sender.tab.url || !sender.tab.url.includes('matrix.tencent.com')) {
                sendResponse({status: 'error'});
                return;
            }

            chrome.storage.local.get(['ipUsageCount', 'lastResetTime'], (result) => {
                let usageCount = result.ipUsageCount || 0;
                const lastResetTime = result.lastResetTime || Date.now();

                // Usage window: anything older than 10 minutes starts a fresh count.
                const timeDiff = Date.now() - lastResetTime;
                if (timeDiff > 10 * 60 * 1000) {
                    usageCount = 0;
                    chrome.storage.local.set({
                        ipUsageCount: 1,
                        lastResetTime: Date.now()
                    });
                } else {
                    // Cap the counter so the badge never exceeds the 10-use allowance.
                    usageCount = Math.min(usageCount + 1, 10);
                    chrome.storage.local.set({
                        ipUsageCount: usageCount
                    });
                }

            });

            sendResponse({status: 'success'});
        }

        // Manual reset of the local usage counter.
        if (request.action === 'resetUsage') {
            chrome.storage.local.set({
                ipUsageCount: 0,
                lastResetTime: Date.now()
            });

            sendResponse({status: 'success'});
        }

        // Async response: returning true keeps the message channel open.
        if (request.action === 'getStatus') {
            chrome.storage.local.get(['enabled', 'autoRefresh', 'ipUsageCount', 'resetCount'], (result) => {
                sendResponse({
                    enabled: result.enabled !== undefined ? result.enabled : true,
                    autoRefresh: result.autoRefresh !== undefined ? result.autoRefresh : true,
                    ipUsageCount: result.ipUsageCount || 0,
                    resetCount: result.resetCount || 0
                });
            });
            return true;
        }

        return true;
    });

    // Re-inject the content script after a full navigation on the target site,
    // because SPA-style reloads do not always trigger a fresh match.
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (changeInfo.status === 'complete' && tab.url && tab.url.includes('matrix.tencent.com')) {
            chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['content.js']
            }).catch(err => {
            });
        }
    });

    chrome.runtime.onInstalled.addListener(() => {
        chrome.contextMenus.create({
            id: 'openTencent',
            title: 'Open Tencent AI Detect',
            contexts: ['all']
        });
    });

    chrome.contextMenus.onClicked.addListener((info, tab) => {
        if (info.menuItemId === 'openTencent') {
            chrome.tabs.create({
                url: 'https://matrix.tencent.com/ai-detect/'
            });
        }
    });
})();
