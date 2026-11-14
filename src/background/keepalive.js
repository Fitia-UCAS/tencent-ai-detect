// Keeps the relay alive while the feature is switched on.
//
// Two separate questions are answered here, and conflating them was the original bug:
// whether the user still wants the relay (storage), and whether the relay is actually responsive
// (health). A connected native port does not imply a live relay — the host can outlive a crashed
// child — so a failed health check re-sends `ensure` down the existing port instead of assuming
// everything is fine.
//
// `ensure` assumes the host acts on it. A host whose own spawn path broke — the script was
// mid-checkout, an update moved it — accepts the message and does nothing, while the port still
// reports as connected. Asking once a minute then changes nothing for as long as the browser stays
// open. The counter below notices that silence and replaces the host process instead.

export function createKeepAlive({ chrome, health, host, alarmName, keys }) {
    // Two ticks is about two minutes, long enough for a slow respawn to finish on its own.
    const MAX_ENSURE_FAILURES = 2;

    // Consecutive ticks that asked for recovery and saw no relay. Reset by any healthy tick, so a
    // single slow respawn is not mistaken for a wedged host, and kept outside the port because
    // reconnecting must not lose the count.
    let ensureFailures = 0;

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
            ensureFailures = 0;

            // A read-only GET is not a lease renewal; only the host can request an authenticated
            // heartbeat for a child it owns.
            host.command('heartbeat');
            return;
        }

        ensureFailures += 1;

        if (host.isConnected() && ensureFailures >= MAX_ENSURE_FAILURES) {
            ensureFailures = 0;

            // Dropping the port is what forces a new host process; the reconnect asks it for a relay
            // immediately, so recovery lands on this tick rather than the next one.
            host.disconnect();
            host.command('ensure');
            return;
        }

        host.command('ensure');
    }

    return { ensureAlarm, keepAlive, alarmName, MAX_ENSURE_FAILURES };
}
