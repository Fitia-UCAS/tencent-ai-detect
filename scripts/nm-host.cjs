#!/usr/bin/env node

// Native messaging host for the Tencent AI Detect extension.
//
// Chrome/Edge speaks a length-prefixed JSON protocol over stdin/stdout: a 4-byte
// little-endian length, then that many bytes of UTF-8 JSON. This process starts
// the relay on first use, keeps it alive for the whole browser session, and
// reports its address back to the worker.
//
// Lifecycle: the browser launches this process for a Native Messaging port. It
// normally exits when that port closes. MV3 worker suspension/restart can create
// a later host connection, so do not assume one stable host PID for a browser
// session; recovery tests assert the relay owner, not host PID reuse.

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');

const PORT = Number(process.env.RELAY_PORT || 9420);
const RELAY_SCRIPT = path.join(__dirname, 'relay.cjs');
const HEALTH_SERVICE = 'zq-local-relay-v1';

let relay = null;
let relayToken = null;
let shutdownStarted = false;

// --- stdio framing ---------------------------------------------------------
// stdout carries protocol frames only; anything else must go to stderr or it
// would corrupt the stream.

function send(message) {
    const json = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(json.length, 0);
    try {
        process.stdout.write(Buffer.concat([header, json]));
    } catch (error) {
        log('native messaging stdout failed: ' + error.message);
        shutdown();
    }
}

// Broken stdio pipes can also surface as asynchronous EPIPE events.
process.stdout.on('error', error => {
    log('native messaging stdout error: ' + error.message);
    shutdown();
});

function log(text) {
    process.stderr.write(`[nm-host] ${text}\n`);
}

// --- relay supervision -----------------------------------------------------

// A listening TCP port is not the same as a healthy relay. The public service
// marker is a basic accidental-port-collision check, NOT local authentication:
// another process could forge this marker. Never use it to authorize PID kills.
function portOpen(port) {
    return new Promise(resolve => {
        const request = http.get(
            { host: '127.0.0.1', port, path: '/health', timeout: 900 },
            response => {
                let body = '';

                response.setEncoding('utf8');
                response.on('data', chunk => { body += chunk; });
                response.on('end', () => {
                    try {
                        const parsed = JSON.parse(body);
                        resolve(response.statusCode === 200 && parsed &&
                            parsed.ok === true && parsed.service === HEALTH_SERVICE);
                    } catch (e) {
                        resolve(false);
                    }
                });
            }
        );

        request.on('timeout', () => { request.destroy(); resolve(false); });
        request.on('error', () => resolve(false));
    });
}

function heartbeatRelay() {
    // A reused foreign relay is not ours to keep alive or terminate.
    if (!relay || !relayToken) return Promise.resolve(false);
    return new Promise(resolve => {
        const request = http.request({
            host: '127.0.0.1', port: PORT, path: '/keepalive',
            method: 'POST', timeout: 900,
            headers: { 'x-relay-heartbeat-token': relayToken }
        }, response => {
            response.resume();
            resolve(response.statusCode === 204);
        });
        request.on('timeout', () => { request.destroy(); resolve(false); });
        request.on('error', () => resolve(false));
        request.end();
    });
}

async function ensureRelay() {
    if (await portOpen(PORT)) return { ok: true, port: PORT, reused: true };

    if (!relay) {
        relayToken = crypto.randomBytes(32).toString('hex');
        const child = spawn(process.execPath, [RELAY_SCRIPT], {
            stdio: ['ignore', 'ignore', 'pipe'],
            env: Object.assign({}, process.env, {
                RELAY_PORT: String(PORT),
                RELAY_HEARTBEAT_TOKEN: relayToken
            }),
            windowsHide: true
        });
        relay = child;
        child.stderr.on('data', chunk => log('relay: ' + String(chunk).trim()));

        child.on('exit', code => {
            log(`relay exited (${code})`);
            if (relay === child) {
                relay = null;
                relayToken = null;
            }
        });

        child.on('error', error => {
            log('relay failed to start: ' + error.message);
            if (relay === child) {
                relay = null;
                relayToken = null;
            }
        });
    }

    // Give it a moment to bind before answering.
    for (let i = 0; i < 40; i++) {
        if (await portOpen(PORT)) return { ok: true, port: PORT, reused: false };
        await new Promise(r => setTimeout(r, 100));
    }

    // The process exists but never bound the port: do not leave a broken child
    // cached, or every later attempt would reuse it.
    if (relay && !relay.killed) {
        try {
            relay.kill();
        } catch (e) {
        }
    }

    relay = null;
    relayToken = null;

    return { ok: false, port: PORT, reused: false };
}

// --- protocol --------------------------------------------------------------
//
// Frame parsing and message handling are separated. The parser is synchronous
// and only enqueues complete messages; the handler runs them one at a time, so
// an `await` inside one message cannot race with the next chunk arriving on
// stdin or with a second `ensure` running concurrently.

// This control channel carries tiny JSON objects, not file transfers.
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_QUEUED_MESSAGES = 128;
let buffer = Buffer.alloc(0);
const queue = [];
let draining = false;

async function drain() {
    if (draining || shutdownStarted) return;
    draining = true;

    try {
        while (queue.length && !shutdownStarted) {
            const message = queue.shift();
            try {
                if (message.type === 'ping') {
                    send({ type: 'pong', at: Date.now() });
                } else if (message.type === 'ensure') {
                    const result = await ensureRelay();
                    send(Object.assign({ type: 'relay' }, result));
                } else if (message.type === 'heartbeat') {
                    // A missing lease is harmless here: a reused relay belongs
                    // to its original owner and will follow its own lifecycle.
                    await heartbeatRelay();
                } else {
                    send({ type: 'error', message: 'unknown type: ' + message.type });
                }
            } catch (error) {
                log('message handler failed: ' + String(error));
                send({ type: 'error', message: 'message handler failed' });
            }
        }
    } finally {
        // A rejected asynchronous operation must never leave `draining` true.
        draining = false;
    }
}

process.stdin.on('data', chunk => {
    if (shutdownStarted) return;
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 4) {
        const length = buffer.readUInt32LE(0);

        if (length === 0 || length > MAX_MESSAGE_BYTES) {
            log(`invalid frame length ${length}`);
            send({ type: 'error', message: 'invalid frame length' });
            // Length is untrusted: the rest of this stream cannot be parsed
            // reliably once an invalid prefix was received.
            shutdown();
            return;
        }

        if (buffer.length < 4 + length) break;

        const payload = buffer.subarray(4, 4 + length).toString('utf8');
        buffer = buffer.subarray(4 + length);

        let message;
        try {
            message = JSON.parse(payload);
        } catch (e) {
            send({ type: 'error', message: 'bad json' });
            continue;
        }

        if (!message || typeof message !== 'object' || Array.isArray(message) ||
            typeof message.type !== 'string') {
            send({ type: 'error', message: 'invalid message shape' });
            continue;
        }

        if (queue.length >= MAX_QUEUED_MESSAGES) {
            send({ type: 'error', message: 'message queue full' });
            continue;
        }
        queue.push(message);
    }

    void drain();
});

// Closing the port means the browser is going away (or the extension reloaded).
// Either way this process must not outlive it.
function shutdown() {
    if (shutdownStarted) return;
    shutdownStarted = true;

    const child = relay;
    relay = null;
    relayToken = null;

    if (!child || child.exitCode !== null || child.signalCode !== null) {
        process.exit(0);
        return;
    }

    // Wait briefly for the child-exit event. Exiting the host immediately after
    // child.kill() makes shutdown timing harder to observe and verify.
    const timeout = setTimeout(() => {
        log('relay did not exit within 1500ms after termination request');
        process.exit(0);
    }, 1500);

    child.once('exit', () => {
        clearTimeout(timeout);
        process.exit(0);
    });

    try {
        child.kill();
    } catch (e) {
        clearTimeout(timeout);
        log('could not terminate relay: ' + e.message);
        process.exit(0);
    }
}

process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Tell the worker the host is loaded; the relay itself starts on demand.
send({ type: 'ready', port: PORT });
