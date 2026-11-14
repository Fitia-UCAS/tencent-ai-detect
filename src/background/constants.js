// Values the background worker shares across modules.
//
// Kept in one place so the health URL, native host name and storage keys cannot drift apart
// between the modules that read them.

export const RELAY_HEALTH_URL = 'http://127.0.0.1:9420/health';
export const NATIVE_HOST_NAME = 'com.afei.tencent_ai_detect_relay';
export const KEEPALIVE_ALARM = 'relay-keepalive';
export const HEALTH_TIMEOUT_MS = 1500;

// Storage keys written by the worker. The content script writes none of these.
export const KEYS = Object.freeze({
    relayEnabled: 'relayEnabled',
    relayOnline: 'relayOnline',
    autoRefresh: 'autoRefresh',
    resetCount: 'resetCount',
    resetHistory: 'resetHistory',
    lastResetTime: 'lastResetTime',
    ipUsageCount: 'ipUsageCount',
    lastStatus: 'lastStatus',
    // Why the native host could not be reached. Without this a missing registration looks exactly
    // like a healthy idle extension: nothing happens and nothing says why.
    hostError: 'hostError'
});

// Seeded on install only when absent, so an update never resets a user's switches.
export const DEFAULTS = Object.freeze({
    relayEnabled: true,
    autoRefresh: true,
    resetCount: 0,
    ipUsageCount: 0,
    resetHistory: [],
    lastResetTime: () => Date.now()
});

export const RESET_HISTORY_LIMIT = 100;
export const USAGE_WINDOW_MS = 10 * 60 * 1000;
export const USAGE_CAP = 10;
