// The message router.
//
// Every action answers on exactly one channel discipline: actions that reply immediately return
// false (nothing is scheduled), actions that reply later return true so the channel stays open,
// and unknown actions return false — returning true there would hold the channel open forever
// because no callback is ever scheduled.

export function createMessageRouter({ chrome, keys, keepAlive, host, health, usage }) {
    const handlers = {
        setRelay(request, sender, respond) {
            const enabled = request.enabled !== false;
            chrome.storage.local.set({ [keys.relayEnabled]: enabled });

            if (enabled) {
                keepAlive.ensureAlarm();
                host.command('ensure');
            } else {
                chrome.alarms.clear(keepAlive.alarmName);
                host.disconnect();
            }

            health.ping().then(() => respond({ status: 'success', online: !!health.isOnline() }));
            return true;
        },

        relayHealth(request, sender, respond) {
            health.ping()
                .then(body => respond({ status: 'success', ok: !!(body && body.ok), body }))
                .catch(error => respond({
                    status: 'error',
                    ok: false,
                    message: String(error?.message || error)
                }));
            return true;
        },

        logReset(request, sender, respond) {
            usage.logReset({ sender, ip: request.ip, reason: request.reason });
            respond({ status: 'success' });
            return false;
        },

        statusUpdate(request, sender, respond) {
            chrome.storage.local.set({ [keys.lastStatus]: request.payload });
            respond({ status: 'success' });
            return false;
        },

        usageIncrement(request, sender, respond) {
            const accepted = usage.incrementUsage(sender);
            respond({ status: accepted ? 'success' : 'error' });
            return false;
        },

        resetUsage(request, sender, respond) {
            usage.resetUsage();
            respond({ status: 'success' });
            return false;
        },

        getStatus(request, sender, respond) {
            usage.readStatus(respond);
            return true;
        }
    };

    return function route(request, sender, respond) {
        const handler = request && Object.hasOwn(handlers, request.action)
            ? handlers[request.action]
            : null;

        if (!handler) return false;
        return handler(request, sender, respond);
    };
}
