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
import { createHeaderRules } from './header-rules.js';
import { createTrail } from './trail.js';
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
    const keepAlive = createKeepAlive({ chrome, health, host, alarmName: KEEPALIVE_ALARM });
    const usage = createUsageLog({
        chrome, keys: KEYS, defaults: DEFAULTS,
        historyLimit: RESET_HISTORY_LIMIT, usageWindowMs: USAGE_WINDOW_MS, usageCap: USAGE_CAP
    });
    const identity = createHeaderRules({ chrome, log });
    const trail = createTrail({ chrome, key: KEYS.trail });
    const route = createMessageRouter({
        chrome, keys: KEYS, keepAlive, health, usage, identity, trail
    });

    // A live nativePort does not imply a live relay, so the alarm asks the host again rather than
    // trusting the port. The alarm is the only recurring actor in this worker.

    // The relay always runs.
    //
    // There is no switch, because there is no working configuration with it off: the detection socket
    // is rerouted to the relay by URL alone, so stopping the process does not fall back to a direct
    // connection - it fails closed and the page stops detecting with no sign of why. The relay is
    // also the only thing that puts a synthetic address on the socket, and without that the ticket's
    // address and the socket's disagree, which the server refuses every time.
    function startRelay() {
        keepAlive.ensureAlarm();
        host.ensure();
    }

    function start() {
        chrome.alarms.onAlarm.addListener(alarm => {
            if (alarm.name === KEEPALIVE_ALARM) keepAlive.keepAlive();
        });

        registerInjection({ chrome, files: CONTENT_FILES, siteMatch: SITE_MATCH });
        registerMenuClick({ chrome, id: MENU_ID, url: SITE_URL });

        chrome.runtime.onInstalled.addListener(() => {
            usage.seedDefaults(startRelay);
            createMenu({ chrome, id: MENU_ID, title: MENU_TITLE });
        });

        chrome.runtime.onStartup.addListener(startRelay);

        chrome.runtime.onMessage.addListener(route);

        // A closed tab's rules would otherwise hold their slot for the rest of the browser session,
        // and nothing else frees them: the session ruleset belongs to the browser, so it does not
        // know which of these rules a tab that no longer exists put there.
        if (chrome.tabs && chrome.tabs.onRemoved) {
            chrome.tabs.onRemoved.addListener(tabId => { identity.removeTab(tabId); });
        }

        // The worker restarts often; the rules it installed earlier are still there. Read them back
        // so the map describes the browser instead of starting out empty.
        identity.sync();

        // Worker wake-up must re-create the alarm rather than assume the last one survived.
        keepAlive.ensureAlarm();
    }

    return { start, host, health, keepAlive, usage, route };
}
