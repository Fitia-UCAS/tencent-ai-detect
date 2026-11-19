// Reads the relay's /health endpoint and publishes the result.
//
// A parseable JSON body is not the same as a healthy relay: only an explicit ok:true counts.
// Callers rely on that distinction, so the probe returns the body and records the verdict rather
// than collapsing both into a boolean.
//
// The probe also carries the one fact the worker cannot work out for itself: which way the relay
// leaves the machine. Whether a detection was refused with a proxy client switched on or off was
// unanswerable from every log this project kept - the proxy's own log records only its periodic
// guard refresh, minutes away from any press - so the refusal could not be attributed at all. The
// relay already resolves that path when it dials; naming it here gives every later event a value to
// be stamped with.

export function createRelayHealth({
    fetchImpl,
    url,
    relayState,
    timeoutMs,
    publishOutbound = () => {},
    now = () => Date.now()
}) {
    // 'unknown' until the relay has answered once. Distinct from 'direct': a relay that never ran
    // and a relay leaving without a proxy are different things, and the whole point of recording
    // this is that they used to look the same.
    let outboundPath = 'unknown';
    let outboundAt = 0;

    function recordOutbound(body) {
        const next = body && typeof body.outbound === 'string' ? body.outbound : null;
        if (!next) return;

        // The reading time is kept even when the value is unchanged: an old reading is only
        // trustworthy for as long as its age says it is.
        outboundAt = now();

        if (next === outboundPath) return;

        const before = outboundPath;
        outboundPath = next;
        publishOutbound(next, before);
    }

    return {
        async ping() {
            const controller = typeof AbortController === 'function' ? new AbortController() : null;
            const timer = setTimeout(() => {
                if (controller) controller.abort();
            }, timeoutMs);

            try {
                const response = await fetchImpl(url, {
                    signal: controller ? controller.signal : undefined
                });
                const body = await response.json();
                relayState.set(relayState.isHealthy(body));
                recordOutbound(body);
                return body || null;
            } catch {
                relayState.set(false);
                return null;
            } finally {
                clearTimeout(timer);
            }
        },
        isOnline: () => relayState.isOnline(),
        // Exposed so a caller that has already pinged does not re-derive the verdict from the body.
        isHealthy: relayState.isHealthy,
        // What the trail stamps onto each event. `at` is when the relay last reported it, so a stale
        // reading is visible as an age rather than presented as the state of that moment.
        outbound: () => ({ path: outboundPath, at: outboundAt }),
        now
    };
}
