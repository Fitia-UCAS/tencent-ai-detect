// The relay's online flag: one value, one writer.
//
// Two modules learn whether the relay is up - the native host from what its child reports, the health
// probe from asking the port - and the panel reads a single stored value. When each module carried
// its own copy of the writer, the panel showed whichever write landed last, and each had its own idea
// of what counts as healthy.

export function createRelayState({ chrome, state }) {
    // Only an explicit ok:true counts.
    //
    // A parseable body is not the same as a healthy relay, and a truthy value from an unrelated shape
    // must not be read as one: the probe returns the body to its callers precisely so they can tell
    // "answered" from "answered correctly".
    const isHealthy = body => !!body && body.ok === true;

    function set(online) {
        state.online = online === true;
        chrome.storage.local.set({ relayOnline: state.online });
        return state.online;
    }

    return {
        set,
        isHealthy,
        isOnline: () => state.online === true
    };
}
