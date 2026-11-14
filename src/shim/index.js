// Runs in the page's own world at document_start, before the site's bundle.
//
// The classification socket is redirected through the local relay. The wrapper
// deliberately preserves the WebSocket/EventTarget surface exposed to the page:
// listeners belong to the wrapper, not to a replaceable underlying socket.
//
// If the relay cannot establish a connection before opening, the wrapper falls
// back to the original URL. A failed relay attempt is kept invisible to the page.
(function() {
    'use strict';

    if (window.__zqRelayShim) return;

    const RELAY_URL = 'ws://127.0.0.1:9420/ws';
    const PATTERN = 'ai_gen_txt_server';

    // A frame produced while the socket is still connecting is held rather than
    // thrown away. The page sends at most a couple of frames this way, so the
    // bound is only a guard against a runaway loop.
    const MAX_PENDING_SENDS = 32;
    const Native = window.WebSocket;
    const EventTargetCtor = window.EventTarget || EventTarget;
    const URLCtor = window.URL || URL;
    const DOMExceptionCtor = window.DOMException || DOMException;

    if (typeof Native !== 'function' || typeof EventTargetCtor !== 'function' ||
        !Native.prototype || !EventTargetCtor.prototype.isPrototypeOf(Native.prototype)) {
        return;
    }

    function makeException(message, name) {
        if (typeof DOMExceptionCtor === 'function') {
            return new DOMExceptionCtor(message, name);
        }
        const error = new Error(message);
        error.name = name;
        return error;
    }

    // Validate the caller's URL before substituting the relay URL. Otherwise an
    // invalid original URL could be hidden by the valid local relay address.
    function normalizeWebSocketUrl(value) {
        let parsed;
        try {
            const base = window.location && window.location.href;
            parsed = new URLCtor(String(value), base);
        } catch (error) {
            throw makeException('The WebSocket URL is invalid.', 'SyntaxError');
        }

        if ((parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') ||
            parsed.username || parsed.password || parsed.hash) {
            throw makeException('The WebSocket URL is invalid.', 'SyntaxError');
        }

        return parsed.href;
    }

    function makeSocketEvent(type, source) {
        if (type === 'message' && typeof MessageEvent === 'function') {
            return new MessageEvent('message', {
                data: source.data,
                origin: source.origin,
                lastEventId: source.lastEventId,
                source: source.source,
                ports: source.ports || []
            });
        }

        if (type === 'close' && typeof CloseEvent === 'function') {
            return new CloseEvent('close', {
                wasClean: !!(source && source.wasClean),
                code: source && typeof source.code === 'number' ? source.code : 1006,
                reason: source && typeof source.reason === 'string' ? source.reason : ''
            });
        }

        return new Event(type);
    }

    class ShimSocket extends EventTargetCtor {
        constructor(url, protocols) {
            super();

            this._url = normalizeWebSocketUrl(url);
            this._protocols = protocols;
            this._sock = null;
            this._open = false;
            this._fellBack = false;
            this._failed = false;
            this._closeRequested = false;
            this._binaryType = 'blob';
            this._eventHandlers = Object.create(null);
            this._eventHandlerWrappers = Object.create(null);
            this._pendingSends = [];

            const useRelay = this._url.indexOf(PATTERN) !== -1;
            // Only the detection socket is rerouted, so only that socket may
            // deviate from the native contract. Every other WebSocket on the page
            // must behave exactly like the real one.
            this._relay = useRelay;
            // A synchronous native-constructor error must remain synchronous.
            this._connect(useRelay, true);
        }

        _connect(useRelay, initial) {
            const target = useRelay ? RELAY_URL : this._url;
            let sock;

            try {
                sock = this._protocols === undefined
                    ? new Native(target)
                    : new Native(target, this._protocols);
            } catch (error) {
                if (initial) throw error;
                this._fail();
                return;
            }

            const previous = this._sock;
            this._sock = sock;
            this._open = false;

            try {
                sock.binaryType = this._binaryType;
            } catch (error) {
                // Keep the default if the underlying implementation rejects it.
            }

            if (previous && previous !== sock) {
                // The page never registers listeners on this socket, so clearing
                // these four handlers is sufficient before disposing of it.
                previous.onopen = null;
                previous.onmessage = null;
                previous.onerror = null;
                previous.onclose = null;
                try {
                    previous.close();
                } catch (error) {
                    // The old connection is already failing; disposal is best effort.
                }
            }

            sock.onopen = event => {
                this._open = true;
                this._emit('open', event);
                // Frames held while connecting go out after the page's own open
                // handler, so the normal handshake keeps its place in the queue.
                this._flushPending(sock);
            };

            sock.onmessage = event => {
                this._emit('message', event);
            };

            sock.onerror = event => {
                if (useRelay && !this._open && !this._closeRequested) {
                    this._fallback();
                    return;
                }
                this._emit('error', event);
            };

            sock.onclose = event => {
                const hadOpened = this._open;
                this._open = false;

                if (useRelay && !hadOpened && !this._closeRequested) {
                    this._fallback();
                    return;
                }
                this._emit('close', event);
            };
        }

        _emit(type, source) {
            const event = makeSocketEvent(type, source || {});
            EventTargetCtor.prototype.dispatchEvent.call(this, event);
        }

        _fallback() {
            if (this._fellBack || this._closeRequested) return;
            this._fellBack = true;
            this._connect(false, false);
        }

        _fail() {
            if (this._failed) return;

            const previous = this._sock;
            this._sock = null;
            this._open = false;
            this._failed = true;
            this._pendingSends.length = 0;

            if (previous) {
                previous.onopen = null;
                previous.onmessage = null;
                previous.onerror = null;
                previous.onclose = null;
                try {
                    previous.close();
                } catch (error) {
                    // The socket may already be closed.
                }
            }

            // The native WebSocket failure path queues its terminal events. Keep
            // that task boundary: listeners attached after this callback returns
            // but before the event task runs must still observe the failure.
            setTimeout(() => {
                if (!this._failed) return;
                this._emit('error');
                this._emit('close', { wasClean: false, code: 1006, reason: '' });
            }, 0);
        }

        send(data) {
            const state = this.readyState;

            if (state === Native.CONNECTING) {
                // Only the relay socket gets the tolerant path. It exists because
                // the page sends its handshake frame from the open handler of
                // whichever socket opened while reading `this.websock`, and it
                // overwrites that field when it re-initialises mid-connect — so a
                // newer socket can be handed a frame before it is open, and the
                // native throw lost the handshake frame entirely.
                //
                // Every other socket keeps the native behaviour, including the
                // synchronous InvalidStateError, because the page (and any other
                // code) is entitled to rely on it.
                if (!this._relay) {
                    throw makeException(
                        'The WebSocket is still in the CONNECTING state.',
                        'InvalidStateError'
                    );
                }

                if (this._pendingSends.length >= MAX_PENDING_SENDS) return;
                this._pendingSends.push(data);
                return;
            }

            if (state !== Native.OPEN || !this._sock) return;
            this._write(data);
        }

        _write(data) {
            // Invariant: every send() the page makes leaves as exactly one frame. Two identical
            // payloads are two frames, as the native API does — merging them would leave a retried
            // request waiting for a reply the server was never asked for. Guarded by
            // "a stale open handler sending into a connecting socket delivers every send".
            if (!this._sock) return;
            this._sock.send(data);
        }

        _flushPending(sock) {
            const queued = this._pendingSends.splice(0);

            for (const data of queued) {
                if (this._sock !== sock || sock.readyState !== Native.OPEN) return;
                this._write(data);
            }
        }

        close(code, reason) {
            if (!this._sock) return;

            // Nothing queued can be delivered once the caller asks to close.
            this._pendingSends.length = 0;

            // Set this before calling the native method: a test double or an
            // implementation may dispatch close synchronously. Restore it if
            // native validation rejects the supplied code or reason.
            const wasCloseRequested = this._closeRequested;
            this._closeRequested = true;
            try {
                if (code === undefined && reason === undefined) {
                    this._sock.close();
                } else if (reason === undefined) {
                    this._sock.close(code);
                } else {
                    this._sock.close(code, reason);
                }
            } catch (error) {
                this._closeRequested = wasCloseRequested;
                throw error;
            }
        }

        get readyState() {
            return this._sock ? this._sock.readyState : Native.CLOSED;
        }

        get url() {
            return this._url;
        }

        get protocol() {
            return this._sock ? this._sock.protocol : '';
        }

        get extensions() {
            return this._sock ? this._sock.extensions : '';
        }

        get bufferedAmount() {
            return this._sock ? this._sock.bufferedAmount : 0;
        }

        get binaryType() {
            return this._sock ? this._sock.binaryType : this._binaryType;
        }

        set binaryType(value) {
            if (value !== 'blob' && value !== 'arraybuffer') return;
            this._binaryType = value;
            if (this._sock) this._sock.binaryType = value;
        }
    }

    // Preserve both instanceof checks. EventTargetCtor initialized the internal
    // EventTarget slots in super(); the native WebSocket prototype supplies the
    // WebSocket interface chain and its standard constants.
    Object.setPrototypeOf(ShimSocket.prototype, Native.prototype);
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(key => {
        Object.defineProperty(ShimSocket, key, {
            configurable: false,
            enumerable: true,
            value: Native[key],
            writable: false
        });
    });

    // Event-handler IDL attributes are listeners on the wrapper itself. Updating
    // an existing property handler changes its callback without changing order.
    ['open', 'message', 'error', 'close'].forEach(type => {
        const name = 'on' + type;

        Object.defineProperty(ShimSocket.prototype, name, {
            configurable: true,
            enumerable: true,
            get() {
                return this._eventHandlers[type] || null;
            },
            set(value) {
                const next = typeof value === 'function' ? value : null;
                const previous = this._eventHandlers[type];
                if (previous === next) return;

                let wrapper = this._eventHandlerWrappers[type];
                if (wrapper) {
                    EventTargetCtor.prototype.removeEventListener.call(this, type, wrapper);
                    this._eventHandlerWrappers[type] = null;
                }

                this._eventHandlers[type] = next;
                if (next) {
                    wrapper = function(event) {
                        const handler = this._eventHandlers[type];
                        if (typeof handler === 'function') handler.call(this, event);
                    };
                    this._eventHandlerWrappers[type] = wrapper;
                    EventTargetCtor.prototype.addEventListener.call(this, type, wrapper);
                }
            }
        });
    });

    window.__zqRelayShim = true;
    window.WebSocket = ShimSocket;
})();
