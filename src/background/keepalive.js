// Keeps the relay alive while the feature is switched on.
//
// Two separate questions are answered here, and conflating them was the original bug:
// whether the user still wants the relay (storage), and whether the relay is actually responsive
// (health). A connected native port does not imply a live relay — the host can outlive a crashed
// child — so a failed health check re-sends `ensure` down the existing port instead of assuming
// everything is fine.

export function createKeepAlive({ chrome, health, host, alarmName, keys }) {
    function ensureAlarm() {
        chrome.alarms.get(alarmName, existing => {
            if (!existing) {
                // One minute stays inside the relay's two-minute idle window.
                chrome.alarms.create(alarmName, { periodInMinutes: 1 });
            }
        });
    }

    async function keepAlive() {
        const state = await chrome.storage.local.get([keys.relayEnabled]);

        if (state[keys.relayEnabled] === false) {
            chrome.alarms.clear(alarmName);
            return;
        }

        const body = await health.ping();

        if (body && body.ok === true) {
            // A read-only GET is not a lease renewal; only the host can request an authenticated
            // heartbeat for a child it owns.
            host.command('heartbeat');
            return;
        }

        host.command('ensure');
    }

    return { ensureAlarm, keepAlive, alarmName };
}
