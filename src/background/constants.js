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
    relayOnline: 'relayOnline',
    resetCount: 'resetCount',
    resetHistory: 'resetHistory',
    lastResetTime: 'lastResetTime',
    ipUsageCount: 'ipUsageCount',
    lastStatus: 'lastStatus',
    // The address the page most recently chose. Read by the panel and by diagnostics.
    identityIp: 'identityIp',
    // Why the native host could not be reached. Without this a missing registration looks exactly
    // like a healthy idle extension: nothing happens and nothing says why.
    hostError: 'hostError',
    // Per-tab event trail for the current load. See src/background/trail.js for why the steps cannot
    // be assumed to arrive in one order.
    trail: 'zqTrail',
    // The worker's own log ring, written by src/background/index.js.
    backgroundLog: 'zqBackgroundLog'
});

// Seeded on install only when absent, so an update preserves existing counters and reset history.
export const DEFAULTS = Object.freeze({
    resetCount: 0,
    ipUsageCount: 0,
    resetHistory: [],
    lastResetTime: () => Date.now()
});

export const RESET_HISTORY_LIMIT = 100;
export const USAGE_WINDOW_MS = 10 * 60 * 1000;
export const USAGE_CAP = 10;
