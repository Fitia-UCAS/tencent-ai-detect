// Owns the native messaging port and the relay's online flag.
//
// The port is the only thing that can start or stop the relay process, so every caller goes
// through this module rather than touching chrome.runtime.connectNative directly. The `state`
// object is shared with the health probe: both learn whether the relay is up, and both must
// publish that to storage so the side panel reads one value.

export function createNativeHost({ chrome, hostName, state, log = () => {} }) {
    // The browser reports a missing registration only as a disconnect right after connecting, so
    // the reason has to be captured here or it is lost. It is what tells the user to run the
    // registration script instead of wondering why the extension does nothing.
    function recordFailure(message) {
        const text = String(message || '');
        if (!text) return;
        if (state.hostError === text) return;

        state.hostError = text;
        log('native host unavailable: ' + text);
        chrome.storage.local.set({ hostError: text });
    }

    function clearFailure() {
        if (!state.hostError) return;
        state.hostError = null;
        chrome.storage.local.set({ hostError: null });
    }

    function publish(online) {
        state.online = online;
        chrome.storage.local.set({ relayOnline: online });
    }

    // Opens the port and wires its listeners. Sends nothing: what a fresh port should ask for
    // belongs to the caller, and rebuilding a port is not always an `ensure`.
    function open() {
        if (state.port) return state.port;

        let port;
        try {
            port = chrome.runtime.connectNative(hostName);
        } catch (error) {
            log('connectNative failed: ' + error.message);
            state.port = null;
            recordFailure(error.message);
            return null;
        }

        state.port = port;

        port.onMessage.addListener(message => {
            if (message && message.type === 'relay') {
                // A message proves the host is running, which is also proof the registration works.
                clearFailure();
                publish(!!message.ok);
                log(`relay ready ok=${message.ok} reused=${message.reused}`);
            }
        });

        port.onDisconnect.addListener(() => {
            // A stale port can disconnect after a newer one replaced it; its callback must not
            // clear the live port's state.
            if (state.port !== port) return;

            const error = chrome.runtime.lastError;
            if (error) {
                recordFailure(error.message);
            }

            state.port = null;
            publish(false);
        });

        return port;
    }

    // Opens the port if needed and asks the host to bring the relay up. This is what a caller means
    // by "make sure the relay is running", and the port being new or reused makes no difference.
    function ensure() {
        const port = open();
        if (port) post('ensure');
        return port;
    }

    function post(type) {
        if (!state.port) return false;
        try {
            state.port.postMessage({ type });
            return true;
        } catch (error) {
            // The reference survived but the pipe is gone; drop it so the caller reconnects.
            log('postMessage failed: ' + error.message);
            state.port = null;
            return false;
        }
    }

    function disconnect() {
        if (!state.port) return;
        try {
            state.port.disconnect();
        } catch {
            // Already gone. The state below is what matters.
        }
        state.port = null;
        publish(false);
    }

    // Sends a command down the existing port. A dead port means there is no host process to answer,
    // so the command cannot be delivered at all - the port is rebuilt and asked for `ensure`
    // instead, which is the relay a heartbeat would have been aimed at. The substitution is named
    // at this point rather than buried inside the port setup, because it is a different command.
    function command(type) {
        if (post(type)) return;
        ensure();
    }

    return {
        ensure,
        disconnect,
        command,
        isConnected: () => !!state.port
    };
}
