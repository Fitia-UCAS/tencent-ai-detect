// Composition root: builds the background services and wires browser events to them.
//
// Nothing here holds policy of its own. Each concern lives in its own module and is handed its
// dependencies, which is what lets the unit tests build isolated instances instead of loading the
// whole worker into a sandbox.

import {
    RELAY_HEALTH_URL, NATIVE_HOST_NAME, KEEPALIVE_ALARM, HEALTH_TIMEOUT_MS,
    KEYS, DEFAULTS, RESET_HISTORY_LIMIT, USAGE_WINDOW_MS, USAGE_CAP
} from './constants.js';
import { createNativeHost } from './native-host.js';
import { createRelayHealth } from './relay-health.js';
import { createKeepAlive } from './keepalive.js';
import { createUsageLog } from './usage-log.js';
import { createMessageRouter } from './messages.js';
import { createIdentityRules } from './identity.js';
import { registerInjection, registerMenuClick, createMenu } from './page-hooks.js';
import { CONTENT_FILES } from '../content/files.js';

const SITE_MATCH = 'matrix.tencent.com';
const MENU_ID = 'openTencent';
const MENU_TITLE = 'Open Tencent AI Detect';
const SITE_URL = 'https://matrix.tencent.com/ai-detect/';

export function createBackground({ chrome, fetchImpl = fetch, log = () => {} }) {
    const state = { port: null, online: false };

    const host = createNativeHost({ chrome, hostName: NATIVE_HOST_NAME, state, log });
    const health = createRelayHealth({
        chrome, fetchImpl, url: RELAY_HEALTH_URL, state, timeoutMs: HEALTH_TIMEOUT_MS
    });
    const keepAlive = createKeepAlive({ chrome, health, host, alarmName: KEEPALIVE_ALARM, keys: KEYS });
    const usage = createUsageLog({
        chrome, keys: KEYS, defaults: DEFAULTS,
        historyLimit: RESET_HISTORY_LIMIT, usageWindowMs: USAGE_WINDOW_MS, usageCap: USAGE_CAP
    });
    const identity = createIdentityRules({ chrome, log });
    const route = createMessageRouter({
        chrome, keys: KEYS, keepAlive, host, health, usage, identity
    });

    // A live nativePort does not imply a live relay, so the alarm asks the host again rather than
    // trusting the port. The alarm is the only recurring actor in this worker.

    // Apply the persisted switch only after defaults exist; never start the host the user stopped.
    function applyRelayPreference() {
        chrome.storage.local.get([KEYS.relayEnabled], stored => {
            if (stored[KEYS.relayEnabled] === false) {
                chrome.alarms.clear(KEEPALIVE_ALARM);
                host.disconnect();
                chrome.storage.local.set({ [KEYS.relayOnline]: false });
                return;
            }

            keepAlive.ensureAlarm();
            host.ensure();
        });
    }

    function start() {
        chrome.alarms.onAlarm.addListener(alarm => {
            if (alarm.name === KEEPALIVE_ALARM) keepAlive.keepAlive();
        });

        registerInjection({ chrome, files: CONTENT_FILES, siteMatch: SITE_MATCH });
        registerMenuClick({ chrome, id: MENU_ID, url: SITE_URL });

        chrome.runtime.onInstalled.addListener(() => {
            usage.seedDefaults(applyRelayPreference);
            createMenu({ chrome, id: MENU_ID, title: MENU_TITLE });
        });

        chrome.runtime.onStartup.addListener(applyRelayPreference);

        chrome.runtime.onMessage.addListener(route);

        // The worker restarts often; the rules it installed earlier are still there. Read them back
        // so `current` describes the browser instead of starting out empty.
        identity.sync();

        // Worker wake-up must respect the saved switch instead of re-creating the alarm blindly.
        chrome.storage.local.get([KEYS.relayEnabled], stored => {
            if (stored[KEYS.relayEnabled] !== false) keepAlive.ensureAlarm();
        });
    }

    return { start, host, health, keepAlive, usage, route };
}
