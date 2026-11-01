(function() {
    'use strict';

    // Identity helper kept from the original bundle; safe to pass through.
    const _0x = function(str) {
        return str;
    };

    // ---------------------------------------------------------------------
    // Relay lifecycle
    //
    // The server keys its abuse throttle on the client IP it sees, and the only
    // way to change that from inside the browser is to let a local relay open
    // the socket. Nothing is ever attached to the tab, so Chromium's debug bar
    // cannot appear.
    //
    // The relay is user-controlled: it runs only while the switch is on, and the
    // worker pings it on an alarm so it can tell "still wanted" from "browser is
    // gone". Closing the side panel changes nothing; only turning the switch off
    // (or closing the browser) stops it.
    // ---------------------------------------------------------------------

    const RELAY_HEALTH = 'http://127.0.0.1:9420/health';
    const HOST_NAME = 'com.afei.tencent_ai_detect_relay';
    const PING_ALARM = 'relay-keepalive';

    let nativePort = null;
    let relayOnline = false;

    function log(text) {
        // Keeps the worker's own diagnostics out of the popup.
        console.debug('[zq]', text);
    }

    // --- native host -------------------------------------------------------

    function connectHost() {
        if (nativePort) return nativePort;

        try {
            nativePort = chrome.runtime.connectNative(HOST_NAME);
        } catch (e) {
            log('connectNative failed: ' + e.message);
            nativePort = null;
            return null;
        }

        nativePort.onMessage.addListener(message => {
            if (message && message.type === 'relay') {
                relayOnline = !!message.ok;
                chrome.storage.local.set({ relayOnline: relayOnline });
                log(`relay ready ok=${message.ok} reused=${message.reused}`);
            }
        });

        const connectedPort = nativePort;
        connectedPort.onDisconnect.addListener(() => {
            // A stale port can disconnect after a newer one was connected.
            // Its callback must not clear the new port's live state.
            const error = chrome.runtime.lastError;
            if (nativePort !== connectedPort) return;
            if (error) log('native disconnected: ' + error.message);

            nativePort = null;
            relayOnline = false;
            chrome.storage.local.set({ relayOnline: false });
        });

        // Ask the host to make sure the relay is up.
        try {
            nativePort.postMessage({ type: 'ensure' });
        } catch (e) {
            log('postMessage failed: ' + e.message);
        }

        return nativePort;
    }

    function disconnectHost() {
        if (!nativePort) return;

        try {
            nativePort.disconnect();
        } catch (e) {
        }

        nativePort = null;
        relayOnline = false;
        chrome.storage.local.set({ relayOnline: false });
    }

    // --- health ------------------------------------------------------------

    function pingRelay() {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = setTimeout(() => {
            if (controller) controller.abort();
        }, 1500);

        return fetch(RELAY_HEALTH, { signal: controller ? controller.signal : undefined })
            .then(response => response.json())
            .then(body => {
                clearTimeout(timer);
                relayOnline = !!(body && body.ok);
                chrome.storage.local.set({ relayOnline: relayOnline });
                return body || null;
            })
            .catch(() => {
                clearTimeout(timer);
                relayOnline = false;
                chrome.storage.local.set({ relayOnline: false });
                return null;
            });
    }

    // Called on every alarm tick while the feature is enabled: this both keeps
    // the relay from idling out and revives it if it died.
    //
    // A live nativePort does not mean a live relay. The host can outlive its
    // child (the relay crashed after starting), in which case the port is still
    // connected while /health fails. Sending `ensure` down the existing port
    // makes the host respawn the child; only when no port exists does the worker
    // connect a new one.
    async function keepAlive() {
        const state = await chrome.storage.local.get(['relayEnabled']);

        if (state.relayEnabled === false) {
            chrome.alarms.clear(PING_ALARM);
            return;
        }

        const body = await pingRelay();

        // A parseable JSON response is not necessarily a healthy relay. Only
        // the explicit ok:true state should suppress the recovery command.
        if (body && body.ok === true) {
            // A read-only GET is not a lease renewal. Only the native host can
            // request an authenticated heartbeat for a child it owns.
            if (nativePort) {
                try {
                    nativePort.postMessage({ type: 'heartbeat' });
                } catch (e) {
                    nativePort = null;
                    connectHost();
                }
            } else {
                connectHost();
            }
            return;
        }

        if (nativePort) {
            try {
                nativePort.postMessage({ type: 'ensure' });
            } catch (e) {
                // The port is dead even though the reference survived; drop it
                // so the next line reconnects.
                nativePort = null;
                connectHost();
            }
            return;
        }

        connectHost();
    }

    function ensureAlarm() {
        chrome.alarms.get(PING_ALARM, existing => {
            if (!existing) {
                // 1 minute keeps the relay's 2-minute idle window open.
                chrome.alarms.create(PING_ALARM, { periodInMinutes: 1 });
            }
        });
    }

    chrome.alarms.onAlarm.addListener(alarm => {
        if (alarm.name === PING_ALARM) keepAlive();
    });

    // --- wiring ------------------------------------------------------------

    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (changeInfo.status !== 'complete' || !tab.url || !tab.url.includes('matrix.tencent.com')) {
            return;
        }

        chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ['content.js']
        }).catch(() => {});
    });

    // Seed only the keys that are missing. onInstalled also fires on update, so
    // writing every default unconditionally would wipe the user's switch state
    // and reset history on each version bump.
    chrome.runtime.onInstalled.addListener(() => {
        chrome.storage.local.get(
            ['relayEnabled', 'autoRefresh', 'resetCount', 'ipUsageCount', 'resetHistory', 'lastResetTime'],
            existing => {
                const seed = {};

                if (existing.relayEnabled === undefined) seed.relayEnabled = true;
                if (existing.autoRefresh === undefined) seed.autoRefresh = true;
                if (existing.resetCount === undefined) seed.resetCount = 0;
                if (existing.ipUsageCount === undefined) seed.ipUsageCount = 0;
                if (existing.resetHistory === undefined) seed.resetHistory = [];
                if (existing.lastResetTime === undefined) seed.lastResetTime = Date.now();

                // Apply the persisted preference only after defaults have been
                // written. onInstalled also fires on extension updates; never
                // start the native host if the user previously switched it off.
                const applyRelayPreference = () => {
                    chrome.storage.local.get(['relayEnabled'], state => {
                        if (state.relayEnabled === false) {
                            chrome.alarms.clear(PING_ALARM);
                            disconnectHost();
                            chrome.storage.local.set({ relayOnline: false });
                            return;
                        }

                        ensureAlarm();
                        connectHost();
                    });
                };

                if (Object.keys(seed).length) {
                    chrome.storage.local.set(seed, applyRelayPreference);
                } else {
                    applyRelayPreference();
                }
            }
        );

        chrome.contextMenus.create({
            id: 'openTencent',
            title: 'Open Tencent AI Detect',
            contexts: ['all']
        });
    });

    chrome.runtime.onStartup.addListener(() => {
        chrome.storage.local.get(['relayEnabled'], state => {
            if (state.relayEnabled === false) {
                chrome.alarms.clear(PING_ALARM);
                chrome.storage.local.set({ relayOnline: false });
                return;
            }

            ensureAlarm();
            connectHost();
        });
    });

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        // The switch. Turning it on starts the relay, turning it off stops it.
        if (request.action === 'setRelay') {
            const enabled = request.enabled !== false;

            chrome.storage.local.set({ relayEnabled: enabled });

            if (enabled) {
                ensureAlarm();
                nativePort ? nativePort.postMessage({ type: 'ensure' }) : connectHost();
                pingRelay().then(() => sendResponse({ status: 'success', online: relayOnline }));
            } else {
                chrome.alarms.clear(PING_ALARM);
                disconnectHost();
                pingRelay().then(() => sendResponse({ status: 'success', online: relayOnline }));
            }

            return true;
        }

        // Relayed to the worker because a content-script fetch is treated as a
        // page request and blocked by CORS in MV3.
        if (request.action === 'relayHealth') {
            pingRelay()
                .then(body => sendResponse({ status: 'success', ok: !!(body && body.ok), body: body }))
                .catch(error => sendResponse({ status: 'error', ok: false, message: String(error.message || error) }));

            return true;
        }

        // Append a reset event to the capped history log (keep the newest 100).
        if (request.action === 'logReset') {
            chrome.storage.local.get(['resetCount', 'resetHistory'], (result) => {
                const resetCount = (result.resetCount || 0) + 1;
                const resetHistory = result.resetHistory || [];

                resetHistory.push({
                    time: Date.now(),
                    tabId: sender?.tab?.id,
                    url: sender?.tab?.url,
                    ip: request.ip,
                    reason: request.reason
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
            return false;
        }

        // The content script reports every rotation; kept for diagnostics.
        if (request.action === 'statusUpdate') {
            chrome.storage.local.set({ lastStatus: request.payload });
            sendResponse({status: 'success'});
            return false;
        }

        // Count a usage hit; only accept it from the target site.
        if (request.action === 'usageIncrement') {
            if (!sender.tab || !sender.tab.url || !sender.tab.url.includes('matrix.tencent.com')) {
                sendResponse({status: 'error'});
                return false;
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
            return false;
        }

        // Manual reset of the local usage counter.
        if (request.action === 'resetUsage') {
            chrome.storage.local.set({
                ipUsageCount: 0,
                lastResetTime: Date.now()
            });

            sendResponse({status: 'success'});
            return false;
        }

        // Async response: returning true keeps the message channel open.
        if (request.action === 'getStatus') {
            chrome.storage.local.get(
                ['relayEnabled', 'relayOnline', 'autoRefresh', 'ipUsageCount', 'resetCount', 'lastStatus'],
                (result) => {
                    sendResponse({
                        relayEnabled: result.relayEnabled !== false,
                        relayOnline: result.relayOnline === true,
                        autoRefresh: result.autoRefresh !== undefined ? result.autoRefresh : true,
                        ipUsageCount: result.ipUsageCount || 0,
                        resetCount: result.resetCount || 0,
                        lastStatus: result.lastStatus || null
                    });
                }
            );
            return true;
        }

        // Unknown actions have no asynchronous response. Returning true here
        // would keep the message channel open forever because no callback is
        // scheduled for an unrecognized request.
        return false;
    });

    chrome.contextMenus.onClicked.addListener((info, tab) => {
        if (info.menuItemId === 'openTencent') {
            chrome.tabs.create({
                url: 'https://matrix.tencent.com/ai-detect/'
            });
        }
    });

    // Worker wake-up must respect the saved user switch, not recreate an alarm
    // unconditionally after the user has deliberately disabled the feature.
    chrome.storage.local.get(['relayEnabled'], state => {
        if (state.relayEnabled !== false) ensureAlarm();
    });
})();
