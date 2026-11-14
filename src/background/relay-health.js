// Reads the relay's /health endpoint and publishes the result.
//
// A parseable JSON body is not the same as a healthy relay: only an explicit ok:true counts.
// Callers rely on that distinction, so the probe returns the body and records the verdict rather
// than collapsing both into a boolean.

export function createRelayHealth({
    chrome,
    fetchImpl,
    url,
    state,
    timeoutMs,
    now = () => Date.now()
}) {
    function publish(online) {
        state.online = online;
        chrome.storage.local.set({ relayOnline: online });
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
                publish(!!(body && body.ok));
                return body || null;
            } catch {
                publish(false);
                return null;
            } finally {
                clearTimeout(timer);
            }
        },
        isOnline: () => state.online === true,
        now
    };
}
