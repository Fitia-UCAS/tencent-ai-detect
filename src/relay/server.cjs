#!/usr/bin/env node

// Local relay for the Tencent AI Detect classification socket.
//
// The page opens wss://matrix.tencent.com/ai_gen_txt_server/getClassify and the
// server throttles per client IP. A browser cannot attach a header to a
// WebSocket handshake from JS, and the only in-browser API that can —
// chrome.debugger — shows Chromium's debug bar for as long as it is attached.
//
// This process is the way out: it speaks plain WS to the page, opens the real
// connection itself with a fresh synthetic X-Forwarded-For per connection, and
// pipes frames both ways. Runs on loopback only, no dependencies.

const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const tls = require('node:tls');
const { resolveIdleTimeout } = require('./config.cjs');

const PORT = Number(process.env.RELAY_PORT || 9420);
const HOST = 'matrix.tencent.com';
// Public, non-secret service identifier for basic readiness checks.
// This is NOT authentication against malicious local processes.
const HEALTH_SERVICE = 'zq-local-relay-v1';
const UPSTREAM_PATH = '/ai_gen_txt_server/getClassify';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Local-only defenses. These limits apply in both directions, independently
// of what the remote service accepts.
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_BUFFERED_BYTES = 2 * MAX_FRAME_BYTES;
const MAX_QUEUED_BYTES = 2 * MAX_FRAME_BYTES;
const MAX_QUEUED_FRAMES = 32;
// A message may be split across frames, and Chromium does so for anything above
// 128 KiB. The reassembled message is what gets queued and forwarded, so the cap
// applies to the whole message rather than to a single fragment.
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_ACTIVE_CONNECTIONS = 16;
const ALLOWED_ORIGIN = `https://${HOST}`;
const HEARTBEAT_TOKEN = process.env.RELAY_HEARTBEAT_TOKEN || '';

function appendBounded(previous, chunk) {
    if (previous.length + chunk.length > MAX_BUFFERED_BYTES) {
        throw new Error('receive buffer limit exceeded');
    }
    return Buffer.concat([previous, chunk]);
}

function denyUpgrade(socket, status = '403 Forbidden') {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}


const PREFIXES = [
    '112.80', '112.82', '112.51', '112.55', '112.157', '112.214',
    '116.25', '120.204', '183.192', '221.226', '58.216', '61.147',
    '180.97', '182.61', '39.156', '223.5', '106.11', '121.40',
    '118.31', '121.199', '140.205', '47.96', '101.226', '175.6',
    '222.186', '110.184', '171.88', '125.64', '182.150', '119.147'
];

function randomIp() {
    const prefix = PREFIXES[crypto.randomInt(PREFIXES.length)];
    const octet = () => crypto.randomInt(1, 255);

    return `${prefix}.${octet()}.${octet()}`;
}

// The page may name the address to use, so its captcha request and this socket agree - the ticket
// is bound to the address that fetched it. Anything that is not a plain IPv4 literal is ignored
// rather than trusted: the value is written into an upstream header, and a newline in it would let
// a caller inject arbitrary headers.
function isIpv4(value) {
    if (typeof value !== 'string' || value.length > 15) return false;

    const parts = value.split('.');
    if (parts.length !== 4) return false;

    return parts.every(part => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

// Names a client frame by the field it carries, for diagnostics only. The
// handshake is ordered (fingerprint, captcha ticket, detection text), so knowing
// which of them a connection has already seen is enough to reason about it.
function labelFramePayload(payload) {
    try {
        const parsed = JSON.parse(Buffer.isBuffer(payload) ? payload.toString('utf8') : payload);

        if (parsed && typeof parsed === 'object') {
            if (parsed.access_token) return 'token';
            if (parsed.fp) return 'fp';
            if (parsed.ticket) return 'ticket';
            if ('text' in parsed) return 'text';
        }
    } catch (e) {
    }

    return 'other';
}

// --- frame codec -----------------------------------------------------------

function encodeFrame(payload, opcode, masked) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    const head = [];

    head.push(0x80 | opcode);

    const maskBit = masked ? 0x80 : 0x00;

    if (data.length < 126) {
        head.push(maskBit | data.length);
    } else if (data.length < 65536) {
        head.push(maskBit | 126, data.length >> 8, data.length & 0xff);
    } else {
        head.push(maskBit | 127);
        for (let i = 7; i >= 0; i--) head.push(Number((BigInt(data.length) >> BigInt(i * 8)) & 0xffn));
    }

    const header = Buffer.from(head);

    if (!masked) return Buffer.concat([header, data]);

    const mask = crypto.randomBytes(4);
    const body = Buffer.from(data);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];

    return Buffer.concat([header, mask, body]);
}

// A close frame body is a two-byte code plus an optional reason.
function closeBody(code, reason = '') {
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    if (reason) body.write(reason, 2);
    return body;
}

// Pulls complete frames out of a buffer; returns what was decoded plus the
// remaining partial bytes.
//
// A frame is not necessarily a whole message: Chromium splits anything above 128 KiB into
// one text frame with FIN=0 followed by continuation frames. Both forms are legal and are
// returned here with their FIN bit intact; createReassembler() turns them back into
// messages. Control frames must not be fragmented, so a fragmented close or ping is
// rejected rather than silently accepted.
function decodeFrames(buffer) {
    const frames = [];
    let offset = 0;

    while (offset + 2 <= buffer.length) {
        const first = buffer[offset];
        const opcode = first & 0x0f;
        const fin = (first & 0x80) !== 0;
        const masked = (buffer[offset + 1] & 0x80) !== 0;
        // Reserved bits must be zero: nothing here negotiates an extension.
        if ((first & 0x70) || ![0x0, 0x1, 0x2, 0x8, 0x9, 0xa].includes(opcode)) {
            throw new Error('unsupported WebSocket frame');
        }
        // A control frame carries no fragment state and must arrive complete.
        if (opcode >= 0x8 && !fin) {
            throw new Error('fragmented control frame');
        }
        let length = buffer[offset + 1] & 0x7f;
        let cursor = offset + 2;

        if (length === 126) {
            if (cursor + 2 > buffer.length) break;
            length = buffer.readUInt16BE(cursor);
            cursor += 2;
        } else if (length === 127) {
            if (cursor + 8 > buffer.length) break;
            const length64 = buffer.readBigUInt64BE(cursor);
            if (length64 > BigInt(MAX_FRAME_BYTES)) {
                throw new Error('WebSocket frame too large');
            }
            length = Number(length64);
            cursor += 8;
        }

        if (length > MAX_FRAME_BYTES || (opcode >= 0x8 && length > 125)) {
            throw new Error('WebSocket frame too large or invalid control frame');
        }

        let mask;
        if (masked) {
            if (cursor + 4 > buffer.length) break;
            mask = buffer.slice(cursor, cursor + 4);
            cursor += 4;
        }

        if (cursor + length > buffer.length) break;

        const payload = Buffer.from(buffer.slice(cursor, cursor + length));
        if (masked) {
            for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        }

        frames.push({ opcode, payload, fin });
        offset = cursor + length;
    }

    return { frames, rest: buffer.slice(offset) };
}

// Turns frames back into messages, per direction.
//
// Without this, a page that sends more than 128 KiB in one call has its message split into
// fragments the relay used to reject outright, closing the socket. Reassembling restores
// plain "one call, one message" semantics for everything downstream: the queue, the byte
// accounting, the retry labels and the upstream write all see whole messages again.
function createReassembler(limit = MAX_MESSAGE_BYTES) {
    let opcode = null;
    let chunks = [];
    let size = 0;

    return {
        // Returns ready entries in order. Data messages appear as { opcode, payload };
        // control frames pass straight through as they arrive, since they may be
        // interleaved with the fragments of a message.
        push(frame) {
            const ready = [];

            if (frame.opcode >= 0x8) {
                ready.push({ opcode: frame.opcode, payload: frame.payload, control: true });
                return ready;
            }

            if (frame.opcode !== 0x0) {
                if (opcode !== null) throw new Error('new data frame while a message is in progress');
                opcode = frame.opcode;
            } else if (opcode === null) {
                throw new Error('continuation frame without a message');
            }

            chunks.push(frame.payload);
            size += frame.payload.length;

            if (size > limit) throw new Error('reassembled message too large');

            if (frame.fin) {
                ready.push({ opcode, payload: Buffer.concat(chunks, size), control: false });
                opcode = null;
                chunks = [];
                size = 0;
            }

            return ready;
        }
    };
}

// --- upstream connection ---------------------------------------------------

// Opens the real classification socket with a synthetic client address.
// Every stage has its own timeout: a stalled connect, a stalled TLS handshake or
// a server that never answers the Upgrade would otherwise leave the page stuck
// in CONNECTING forever, which MAX_ATTEMPTS cannot help with because the promise
// never settles.
const CONNECT_TIMEOUT_MS = 8000;
const UPGRADE_TIMEOUT_MS = 10000;

function openUpstream(ip) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;

        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            fn(value);
        };

        const arm = (ms, message) => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                finish(reject, new Error(message));
                try { socket.destroy(); } catch (e) {}
            }, ms);
        };

        const socket = net.connect(443, HOST);
        const key = crypto.randomBytes(16).toString('base64');

        arm(CONNECT_TIMEOUT_MS, `connect timeout to ${HOST}`);

        socket.once('error', error => finish(reject, error));
        socket.once('close', () => {
            if (!settled) finish(reject, new Error('socket closed before upgrade'));
        });

        socket.once('connect', () => {
            arm(UPGRADE_TIMEOUT_MS, `upgrade timeout from ${HOST}`);

            // Diagnostic only: RELAY_NO_SPOOF=1 sends the connection without a
            // synthetic client address, so the upstream sees the real one. Used
            // to tell "the transport is broken" apart from "the captcha ticket
            // does not match the spoofed address". Off by default.
            const spoofed = process.env.RELAY_NO_SPOOF === '1'
                ? ''
                : `X-Forwarded-For: ${ip}\r\n`;

            const secure = tls.connect({ socket, servername: HOST }, () => {
                secure.write(
                    `GET ${UPSTREAM_PATH} HTTP/1.1\r\n` +
                    `Host: ${HOST}\r\n` +
                    'Upgrade: websocket\r\n' +
                    'Connection: Upgrade\r\n' +
                    `Sec-WebSocket-Key: ${key}\r\n` +
                    'Sec-WebSocket-Version: 13\r\n' +
                    `Origin: https://${HOST}\r\n` +
                    spoofed +
                    'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                    '(KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36\r\n\r\n'
                );
            });

            secure.once('error', error => finish(reject, error));

            let raw = Buffer.alloc(0);
            let upgraded = false;

            const onData = chunk => {
                raw = Buffer.concat([raw, chunk]);

                if (!upgraded) {
                    const idx = raw.indexOf('\r\n\r\n');
                    if (idx === -1) return;

                    const head = raw.slice(0, idx).toString();
                    raw = raw.slice(idx + 4);

                    if (!/^HTTP\/1\.[01] 101/.test(head)) {
                        finish(reject, new Error('upstream refused upgrade: ' + head.split('\r\n')[0]));
                        secure.destroy();
                        return;
                    }

                    upgraded = true;
                    secure.removeListener('data', onData);

                    // Anything after the upgrade headers in the same TCP chunk is
                    // already WebSocket data. It is handed to the caller as
                    // `initial`; dropping it would lose the first frame.
                    if (process.env.RELAY_DEBUG) process.stderr.write(`upstream ok ${ip} pre=${raw.length}\n`);
                    finish(resolve, { secure, ip, initial: raw });
                    return;
                }
            };

            secure.on('data', onData);
            secure.once('error', reject);
        });

        socket.once('error', reject);
    });
}

// --- relay -----------------------------------------------------------------

const stats = { connections: 0, ips: [] };
let activeConnections = 0;

// Idle self-shutdown: the worker pings /health while the feature is on, so a
// relay that stops being pinged is one whose worker went away. This is what
// keeps a stopped browser from leaving a node process behind.
const IDLE_TIMEOUT_MS = resolveIdleTimeout(process.env);
let lastPing = Date.now();

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        // Read-only: an untrusted page must not be able to extend the lease
        // just by issuing a simple cross-origin GET request.
        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store'
        });
        // No PID, upstream hostname, or usage statistics on the unauthenticated
        // endpoint. Test tools must identify local processes through the OS.
        res.end(JSON.stringify({ ok: true, service: HEALTH_SERVICE }));
        return;
    }

    if (req.method === 'POST' && req.url === '/keepalive') {
        const supplied = req.headers['x-relay-heartbeat-token'];
        const expected = Buffer.from(HEARTBEAT_TOKEN);
        const actual = Buffer.from(typeof supplied === 'string' ? supplied : '');
        if (!HEARTBEAT_TOKEN || expected.length !== actual.length ||
            !crypto.timingSafeEqual(expected, actual)) {
            res.writeHead(403, { 'Cache-Control': 'no-store' });
            res.end();
            return;
        }
        lastPing = Date.now();
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
        return;
    }

    res.writeHead(404);
    res.end('not found');
});

server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    const connection = String(req.headers.connection || '').toLowerCase().split(',').map(x => x.trim());
    const validKey = typeof key === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(key);

    // The path may carry the address the page chose for this load: /ws?xff=1.2.3.4. Accepting it is
    // what lets the captcha request and this socket carry the same address - the ticket is bound to
    // the address that fetched it, so a socket on a different one is refused.
    const url = String(req.url || '');
    const queryAt = url.indexOf('?');
    const path = queryAt === -1 ? url : url.slice(0, queryAt);
    const requestedIp = queryAt === -1
        ? null
        : new URLSearchParams(url.slice(queryAt + 1)).get('xff');

    if (path !== '/ws' || req.headers.origin !== ALLOWED_ORIGIN) {
        denyUpgrade(socket);
        return;
    }
    if (!validKey || req.headers['sec-websocket-version'] !== '13' ||
        String(req.headers.upgrade || '').toLowerCase() !== 'websocket' ||
        !connection.includes('upgrade')) {
        denyUpgrade(socket, '400 Bad Request');
        return;
    }
    if (activeConnections >= MAX_ACTIVE_CONNECTIONS) {
        denyUpgrade(socket, '503 Service Unavailable');
        return;
    }
    activeConnections += 1;

    const accept = crypto
        .createHash('sha1')
        .update(key + WS_GUID)
        .digest('base64');

    socket.setNoDelay(true);

    // A label for this connection. It becomes the address the server sees through
    // X-Forwarded-For; the page picks it per load and passes it on the socket path so its captcha
    // request can carry the same one.
    const ip = isIpv4(requestedIp) ? requestedIp : randomIp();
    stats.connections += 1;
    stats.ips.push(ip);
    stats.currentIp = ip;

    // Bound the history so a long-lived relay does not grow without limit.
    if (stats.ips.length > 200) stats.ips.splice(0, stats.ips.length - 200);

    let upstream = null;
    let closed = false;
    const pending = [];
    let pendingBytes = 0;
    // Labels of the frames the page has sent on this connection, in order. A
    // retry on a new address creates a brand-new upstream conversation, so this
    // list is what says whether the exchange can still be reconstructed.
    const sentFrameLabels = [];
    let upstreamBlocked = false;
    let upstreamReady = false;
    let toUpstream = Buffer.alloc(0);

    const shutdown = () => {
        if (closed) return;
        closed = true;
        activeConnections -= 1;
        pending.length = 0;
        pendingBytes = 0;
        toUpstream = Buffer.alloc(0);
        try { socket.destroy(); } catch (e) {}
        try { if (upstream) upstream.secure.destroy(); } catch (e) {}
    };

    // Closing a WebSocket is a handshake, not a hang-up (RFC 6455 5.5.1): the side that
    // receives a Close answers with one, and only then is the TCP stream finished. Tearing the
    // socket down instead made the page see 1006 ("abnormal") for what was an ordinary close,
    // so page code that branches on the close code misread a clean shutdown as a failure.
    //
    // The close is also passed on to the other peer so the upstream conversation ends cleanly
    // rather than being dropped. Draining happens on a short timer because a peer that never
    // answers must not keep the connection counted as active.
    const closeGracefully = payload => {
        if (closed) return;
        closed = true;
        activeConnections -= 1;
        pending.length = 0;
        pendingBytes = 0;
        toUpstream = Buffer.alloc(0);

        const body = payload && payload.length ? payload : Buffer.alloc(0);

        try { socket.write(encodeFrame(body, 0x8, false)); } catch (e) {}
        try {
            if (upstream && upstream.secure && typeof upstream.secure.write === 'function') {
                upstream.secure.write(encodeFrame(body, 0x8, true));
            }
        } catch (e) {}

        // Half-close first so anything already queued still leaves, then destroy.
        try { socket.end(); } catch (e) {}
        const drain = setTimeout(() => {
            try { socket.destroy(); } catch (e) {}
            try { if (upstream) upstream.secure.destroy(); } catch (e) {}
        }, 500);

        if (typeof drain.unref === 'function') drain.unref();
    };

    // A bounded queue preserves frame order if the remote stream stalls.
    const flushUpstream = () => {
        if (closed || !upstreamReady || !upstream || upstreamBlocked) return;
        while (pending.length) {
            const frame = pending.shift();
            pendingBytes -= frame.payload.length;
            const sink = upstream.secure;
            if (!sink.write(encodeFrame(frame.payload, frame.opcode, true))) {
                upstreamBlocked = true;
                socket.pause();
                sink.once('drain', () => {
                    if (closed || !upstream || upstream.secure !== sink) return;
                    upstreamBlocked = false;
                    flushUpstream();
                });
                return;
            }
        }
        if (!upstreamBlocked) socket.resume();
    };

    const pageReassembler = createReassembler();

    const onPageData = chunk => {
        if (closed) return;
        let messages;
        try {
            toUpstream = appendBounded(toUpstream, chunk);
            const decoded = decodeFrames(toUpstream);
            toUpstream = decoded.rest;
            messages = decoded.frames.flatMap(frame => pageReassembler.push(frame));
        } catch (_) {
            shutdown();
            return;
        }

        for (const message of messages) {
            if (message.opcode === 0x8) {
                closeGracefully(message.payload);
                return;
            }
            if (pending.length >= MAX_QUEUED_FRAMES ||
                pendingBytes + message.payload.length > MAX_QUEUED_BYTES) {
                shutdown();
                return;
            }
            pending.push(message);
            pendingBytes += message.payload.length;
            // Record what the page has already handed over, so a retry can be
            // judged on whether the upstream conversation can still be rebuilt.
            // Labels are per message, so a fragmented send counts once.
            sentFrameLabels.push(labelFramePayload(message.payload));
            flushUpstream();
        }
    };

    socket.on('data', onPageData);

    // Node hands over the bytes it already read past the request headers. A page
    // sends its first frame the instant the socket opens, so that frame usually
    // arrives in the same segment as the upgrade request. Ignoring `head` dropped
    // it, the server never answered, and the page reported a bare
    // "Invalid request" — for a frame it never received. Replay it through the
    // normal path so ordering and the size limits still apply.
    if (head && head.length) onPageData(head);

    // Upstream occasionally accepts the handshake and then drops the socket
    // without answering. Retrying with a different address costs nothing and
    // keeps the page from seeing a silent failure.
    const MAX_ATTEMPTS = 3;
    let attempt = 0;
    let handshakeSent = false;

    const connectAndServe = () => {
        attempt += 1;

        // A retry keeps the identity the page chose; only the transport is being rebuilt, and a new
        // address here would invalidate the captcha ticket the page is about to send.
        const ip = isIpv4(requestedIp) ? requestedIp : stats.ips[stats.ips.length - 1];
        if (attempt > 1) {
            stats.connections += 1;
            stats.ips.push(ip);
            if (stats.ips.length > 200) stats.ips.splice(0, stats.ips.length - 200);
        }

        openUpstream(ip).then(conn => {
            if (closed) {
                conn.secure.destroy();
                return;
            }
            upstream = conn;
            upstreamReady = true;
            upstreamBlocked = false;

            if (process.env.RELAY_DEBUG) process.stderr.write(`relay start ${ip}\n`);

            // The 101 is only sent once upstream has actually accepted, so a
            // failure to reach the server surfaces as a failed local connect
            // (which the shim can fall back from) instead of a socket that looks
            // open but can never answer.
            if (!handshakeSent) {
                handshakeSent = true;
                socket.write(
                    'HTTP/1.1 101 Switching Protocols\r\n' +
                    'Upgrade: websocket\r\n' +
                    'Connection: Upgrade\r\n' +
                    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
                );
            }

            flushUpstream();

            // The reverse direction has separate per-connection buffer limits.
            let toPage = Buffer.alloc(0);
            let answered = false;
            const outgoing = [];
            let outgoingBytes = 0;
            let pageBlocked = false;

            const flushToPage = () => {
                if (closed || pageBlocked) return;
                while (outgoing.length) {
                    const frame = outgoing.shift();
                    outgoingBytes -= frame.payload.length;
                    if (!socket.write(encodeFrame(frame.payload, frame.opcode, false))) {
                        pageBlocked = true;
                        conn.secure.pause();
                        socket.once('drain', () => {
                            if (closed) return;
                            pageBlocked = false;
                            flushToPage();
                            if (!pageBlocked) conn.secure.resume();
                        });
                        return;
                    }
                }
                if (!pageBlocked) conn.secure.resume();
            };

            const pageReassemblerDown = createReassembler();

            const deliverToPage = chunk => {
                if (closed) return;
                let messages;
                try {
                    toPage = appendBounded(toPage, chunk);
                    const decoded = decodeFrames(toPage);
                    toPage = decoded.rest;
                    messages = decoded.frames.flatMap(frame => pageReassemblerDown.push(frame));
                } catch (_) {
                    shutdown();
                    return;
                }

                for (const message of messages) {
                    if (message.opcode === 0x8) {
                        closeGracefully(message.payload);
                        return;
                    }
                    answered = true;
                    if (outgoing.length >= MAX_QUEUED_FRAMES ||
                        outgoingBytes + message.payload.length > MAX_QUEUED_BYTES) {
                        shutdown();
                        return;
                    }
                    outgoing.push(message);
                    outgoingBytes += message.payload.length;
                    flushToPage();
                }
            };

            // Frames that arrived in the same TCP chunk as the upgrade headers
            // were captured by openUpstream; replay them before subscribing so
            // the first server message is never lost.
            if (conn.initial && conn.initial.length) {
                if (process.env.RELAY_DEBUG) process.stderr.write(`upstream pre-buffer ${conn.initial.length}B\n`);
                deliverToPage(conn.initial);
            }

            conn.secure.on('data', deliverToPage);

            // A retry is only honest while the upstream has seen nothing yet: it
            // starts a brand-new server-side conversation, so any frame already
            // forwarded belongs to a conversation that no longer exists and cannot
            // be replayed. Retrying after forwarding silently corrupted the
            // exchange — the page kept sending into a fresh upstream that never
            // received its fingerprint or captcha ticket. Once frames have gone
            // out, the socket is closed instead, so the page reconnects and
            // performs a complete handshake of its own.
            const canRetry = () => !answered && attempt < MAX_ATTEMPTS && !closed;

            // An upstream failure can emit both error and close. Allow only one
            // terminal transition per connection, never two concurrent retries.
            let terminalHandled = false;
            const onTerminal = kind => {
                if (terminalHandled || closed) return;
                terminalHandled = true;
                if (canRetry() && sentFrameLabels.length === 0) {
                    if (process.env.RELAY_DEBUG) {
                        process.stderr.write(`retry before forwarding (${ip}) attempt=${attempt} event=${kind}\n`);
                    }
                    upstream = null;
                    upstreamReady = false;
                    upstreamBlocked = false;
                    connectAndServe();
                    return;
                }

                if (process.env.RELAY_DEBUG) {
                    process.stderr.write(
                        `upstream ${kind} (${ip}) answered=${answered} attempt=${attempt}` +
                        ` forwarded=[${sentFrameLabels.join(',')}]\n`
                    );
                }

                // The upstream is gone without a Close frame of its own, so the page still
                // deserves a real close handshake instead of a bare TCP teardown: destroying
                // the socket here is what made the page report 1006 for every upstream drop.
                // 1011 tells the page the far side ended unexpectedly, which is the truth.
                closeGracefully(closeBody(1011));
            };

            conn.secure.on('close', () => onTerminal('closed'));
            conn.secure.on('error', () => onTerminal('errored'));
        }).catch(error => {
            if (process.env.RELAY_DEBUG) process.stderr.write(`upstream fail ${ip}: ${error.message}\n`);

            if (attempt < MAX_ATTEMPTS && !closed) {
                connectAndServe();
                return;
            }

            // Upstream never came up. If the 101 has not been sent yet, refusing
            // the local upgrade outright is the cleanest signal: the page sees a
            // failed WebSocket and the shim falls back to the real endpoint.
            if (!handshakeSent) {
                try {
                    socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
                } catch (e) {}
                shutdown();
                return;
            }

            // Already upgraded, so the failure has to be reported as a frame.
            try {
                socket.write(encodeFrame(JSON.stringify({
                    status: 'failed',
                    msg: 'relay upstream failed: ' + error.message
                }), 0x1, false));
            } catch (e) {}
            shutdown();
        });
    };

    socket.on('close', shutdown);
    socket.on('error', shutdown);

    connectAndServe();
});

server.listen(PORT, '127.0.0.1', () => {
    process.stdout.write(`relay listening on http://127.0.0.1:${PORT}\n`);
});

// Exit on its own once nobody has asked for health for a while. Disabled with
// RELAY_IDLE_MS=0 for the standalone `npm run relay` case.
if (IDLE_TIMEOUT_MS > 0) {
    setInterval(() => {
        if (Date.now() - lastPing > IDLE_TIMEOUT_MS) {
            process.stdout.write('relay idle, exiting\n');
            process.exit(0);
        }
    }, Math.max(5000, Math.floor(IDLE_TIMEOUT_MS / 4))).unref();
}

process.on('SIGINT', () => {
    server.close(() => process.exit(0));
});
