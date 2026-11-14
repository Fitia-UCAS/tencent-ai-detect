// Measures how long an upstream conversation survives when pings are answered.
//
// An earlier version of this probe ignored WebSocket control frames, so the
// server's ping went unanswered and it closed the connection after roughly 45
// seconds. A browser answers pings automatically, so that measurement did not
// describe real usage. This version replies to ping with pong and reports whether
// the conversation actually persists, and how long the handshake takes.
const net = require('node:net');
const crypto = require('node:crypto');

const PORT = Number(process.env.RELAY_PORT || 9420);
const HOLD_MS = Number(process.argv[2] || 75000);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function maskedFrame(text) {
    return maskedRaw(Buffer.from(text), 0x1);
}

function maskedRaw(payload, opcode) {
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];

    const len = masked.length;
    const header = len < 126
        ? Buffer.from([0x80 | opcode, 0x80 | len])
        : Buffer.from([0x80 | opcode, 0x80 | 126, (len >> 8) & 0xff, len & 0xff]);

    return Buffer.concat([header, mask, masked]);
}

// Splits a buffer into complete frames, keeping the remainder.
function takeFrame(buffer) {
    if (buffer.length < 2) return null;

    const opcode = buffer[0] & 0x0f;
    let len = buffer[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
        if (buffer.length < 4) return null;
        len = buffer.readUInt16BE(2);
        offset = 4;
    } else if (len === 127) {
        if (buffer.length < 10) return null;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
    }

    if (buffer.length < offset + len) return null;

    return {
        opcode,
        payload: buffer.subarray(offset, offset + len),
        rest: buffer.subarray(offset + len)
    };
}

(async () => {
    const key = crypto.randomBytes(16).toString('base64');
    const socket = net.connect(PORT, '127.0.0.1');

    const started = Date.now();
    let buffer = Buffer.alloc(0);
    let upgradedAt = 0;
    let sentAt = 0;
    let closedAt = null;
    let total = 0;
    let pings = 0;

    const at = () => ((Date.now() - started) / 1000).toFixed(1);

    socket.once('connect', () => {
        socket.write(
            'GET /ws HTTP/1.1\r\n' +
            `Host: 127.0.0.1:${PORT}\r\n` +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Key: ${key}\r\n` +
            'Sec-WebSocket-Version: 13\r\n' +
            'Origin: https://matrix.tencent.com\r\n\r\n'
        );
    });

    socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);

        if (!upgradedAt) {
            const head = buffer.toString('latin1');
            const end = head.indexOf('\r\n\r\n');
            if (end === -1) return;
            upgradedAt = Date.now();
            buffer = buffer.subarray(end + 4);
            sentAt = Date.now();
            socket.write(maskedFrame(JSON.stringify({ fp: crypto.randomBytes(16).toString('hex') })));
            process.stdout.write(`t+${at()}s  sent fingerprint\n`);
        }

        let frame;
        while ((frame = takeFrame(buffer))) {
            buffer = frame.rest;

            if (frame.opcode === 0x9) {
                // The browser does this automatically; without it the server
                // decides the peer is gone and closes.
                pings += 1;
                process.stdout.write(`t+${at()}s  ping  -> pong\n`);
                socket.write(maskedRaw(frame.payload, 0xA));
                continue;
            }

            if (frame.opcode === 0xa) {
                process.stdout.write(`t+${at()}s  pong\n`);
                continue;
            }

            if (frame.opcode === 0x8) {
                process.stdout.write(`t+${at()}s  close frame from upstream\n`);
                continue;
            }

            total += 1;
            const latency = sentAt ? ` (first frame ${Date.now() - sentAt}ms)` : '';
            process.stdout.write(`t+${at()}s  RECV${latency} ${frame.payload.toString('utf8')}\n`);
        }
    });

    socket.on('close', () => { closedAt = Date.now(); });
    socket.on('error', e => process.stdout.write(`  error: ${e.message}\n`));

    process.stdout.write(`holding for ${HOLD_MS / 1000}s, replying to pings...\n`);
    await sleep(HOLD_MS);

    const elapsed = (((closedAt || Date.now()) - started) / 1000).toFixed(1);

    process.stdout.write(`\n`);
    process.stdout.write(`messages  : ${total}\n`);
    process.stdout.write(`pings     : ${pings}\n`);

    if (closedAt === null) {
        process.stdout.write(`state     : still open after ${elapsed}s\n`);
        process.stdout.write(`verdict   : a conversation survives a captcha-length pause\n`);
    } else {
        process.stdout.write(`state     : closed after ${elapsed}s\n`);
        process.stdout.write(`verdict   : the conversation is dropped mid-way\n`);
    }

    try { socket.destroy(); } catch (e) { }
})();
