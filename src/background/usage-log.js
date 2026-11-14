// Storage the worker owns: seeded defaults, the reset log, and the usage counter.
//
// These are the only places that write user-visible counters, so the window and cap rules live
// here once instead of being re-derived at each call site.

export function createUsageLog({ chrome, keys, defaults, historyLimit, usageWindowMs, usageCap, now = () => Date.now() }) {
    // Write only the keys that are absent. onInstalled also fires on update, so writing every
    // default would wipe the user's switches and reset the history on each version bump.
    function seedDefaults(done = () => {}) {
        const wanted = Object.keys(defaults);
        chrome.storage.local.get(wanted, existing => {
            const seed = {};
            for (const key of wanted) {
                if (existing[key] !== undefined) continue;
                const value = defaults[key];
                seed[key] = typeof value === 'function' ? value() : value;
            }

            if (Object.keys(seed).length) chrome.storage.local.set(seed, done);
            else done();
        });
    }

    function logReset({ sender, ip, reason }) {
        chrome.storage.local.get([keys.resetCount, keys.resetHistory], result => {
            const history = (result[keys.resetHistory] || []).slice(-historyLimit + 1);
            history.push({
                time: now(),
                tabId: sender?.tab?.id,
                url: sender?.tab?.url,
                ip,
                reason
            });
            while (history.length > historyLimit) history.shift();

            chrome.storage.local.set({
                [keys.resetCount]: (result[keys.resetCount] || 0) + 1,
                [keys.resetHistory]: history,
                [keys.lastResetTime]: now()
            });
        });
    }

    function incrementUsage(sender) {
        // Only the target site may report a usage hit.
        if (!sender?.tab?.url || !sender.tab.url.includes('matrix.tencent.com')) return false;

        chrome.storage.local.get([keys.ipUsageCount, keys.lastResetTime], result => {
            const last = result[keys.lastResetTime] || now();
            const elapsed = now() - last;

            // A gap longer than the window starts a fresh count for the new address.
            if (elapsed > usageWindowMs) {
                chrome.storage.local.set({
                    [keys.ipUsageCount]: 1,
                    [keys.lastResetTime]: now()
                });
                return;
            }

            chrome.storage.local.set({
                [keys.ipUsageCount]: Math.min((result[keys.ipUsageCount] || 0) + 1, usageCap)
            });
        });

        return true;
    }

    function resetUsage() {
        chrome.storage.local.set({
            [keys.ipUsageCount]: 0,
            [keys.lastResetTime]: now()
        });
    }

    function readStatus(callback) {
        chrome.storage.local.get(
            [keys.relayEnabled, keys.relayOnline, keys.autoRefresh,
                keys.ipUsageCount, keys.resetCount, keys.lastStatus, keys.hostError],
            result => callback({
                relayEnabled: result[keys.relayEnabled] !== false,
                relayOnline: result[keys.relayOnline] === true,
                autoRefresh: result[keys.autoRefresh] !== undefined ? result[keys.autoRefresh] : true,
                ipUsageCount: result[keys.ipUsageCount] || 0,
                resetCount: result[keys.resetCount] || 0,
                lastStatus: result[keys.lastStatus] || null,
                // Present only when the native host failed to start; the panel turns it into a
                // visible instruction instead of leaving the extension looking idle.
                hostError: result[keys.hostError] || null
            })
        );
    }

    return { seedDefaults, logReset, incrementUsage, resetUsage, readStatus };
}
