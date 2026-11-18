// The message router.
//
// Every action answers on exactly one channel discipline: actions that reply immediately return
// false (nothing is scheduled), actions that reply later return true so the channel stays open,
// and unknown actions return false — returning true there would hold the channel open forever
// because no callback is ever scheduled.

export function createMessageRouter({ chrome, keys, keepAlive, health, usage, identity, trail }) {
    // Every action that scopes something to a tab reads it the same way. A message with no sender tab
    // has no tab to scope to, and the module that receives it decides what that means.
    const tabIdOf = sender => (sender && sender.tab ? sender.tab.id : undefined);

    const handlers = {
        relayHealth(request, sender, respond) {
            health.ping()
                .then(body => respond({ status: 'success', ok: health.isHealthy(body), body }))
                .catch(error => respond({
                    status: 'error',
                    ok: false,
                    message: String(error?.message || error)
                }));
            return true;
        },

        // Asks for a reconnect right now instead of on the next alarm tick.
        //
        // The keepalive alarm runs once a minute, so a relay that died between two ticks left the
        // page doing nothing for up to a minute after the user noticed the wait. The content script
        // calls this the moment a rotation finds no relay, so recovery starts immediately; the
        // reconnect itself is the same one the alarm performs.
        relayEnsure(request, sender, respond) {
            keepAlive.ensureAlarm();
            keepAlive.keepAlive()
                .then(() => health.ping())
                .then(body => respond({ status: 'success', ok: health.isHealthy(body) }))
                .catch(error => respond({ status: 'error', ok: false, message: String(error?.message || error) }));
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

        // The address this page load chose. The content script publishes it before sending
        // anything, so the header rule exists by the time the captcha is requested.
        //
        // The rule is installed for the sender's tab only: the rules are per tab, so a second tab
        // publishing its own address cannot take this one's away. A message with no sender tab is
        // refused by the module rather than scoped to everything.
        //
        // The reply waits for the rule to be read back, because "success" here is what the content
        // script treats as permission to let a detection go out. Answering before that check was
        // what made a failed rule installation look like a working one.
        setIdentity(request, sender, respond) {
            const tabId = tabIdOf(sender);

            identity.apply(request.ip, tabId)
                .then(applied => {
                    if (!applied) {
                        respond({ status: 'ignored' });
                        return;
                    }

                    chrome.storage.local.set({ [keys.identityIp]: identity.currentFor(tabId) });
                    respond({ status: 'success' });
                })
                .catch(error => respond({
                    status: 'error',
                    message: String(error && error.message ? error.message : error)
                }));

            return true;
        },

        getStatus(request, sender, respond) {
            usage.readStatus(respond);
            return true;
        },

        // Appends one step of this tab's load to its trail. Fire-and-forget on purpose: the page has
        // already moved on by the time this arrives, so waiting for an answer would only delay it.
        trace(request, sender, respond) {
            const payload = request && request.payload ? request.payload : {};

            trail.add(tabIdOf(sender), payload.name, payload.detail, payload.page);
            respond({ status: 'success' });
            return false;
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