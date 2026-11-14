// Measures how the relay treats two RFC 6455 cases the page can produce but which no
// current test covers: a fragmented message and a clean close handshake.
//
// Both are driven through real sockets against the real relay, with only openUpstream
// stubbed (the same technique test-relay-head-frame.cjs uses), so what is measured is the
// relay's own behaviour toward the page rather than a mock's.
//
// Reported per case: whether the page socket survived, and which frames (if any) the relay
// wrote back. A conforming endpoint must answer a Close with a Close (RFC 6455 5.5.1), and
// must treat a continuation frame as part of the preceding message rather than as an error.
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'relay', 'server.cjs'), 'utf8');
const marker = 'function openUpstream(ip) {';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function frame(opcode, payload, { fin = true, mask = true } = {}) {
    const data = Buffer.from(payload);
    const first = (fin ? 0x80 : 0x00) | opcode;
    let header;

    if (data.length < 126) {
        header = Buffer.from([first, (mask ? 0x80 : 0) | data.length]);
    } else {
        header = Buffer.alloc(4);
        header[0] = first;
        header[1] = (mask ? 0x80 : 0) | 126;
        header.writeUInt16BE(data.length, 2);
    }

    if (!mask) return Buffer.concat([header, data]);

    const key = crypto.randomBytes(4);
    const body = Buffer.from(data);
    for (let i = 0; i < body.length; i++) body[i] ^= key[i % 4];
    return Buffer.concat([header, key, body]);
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            server.close(() => resolve(port));
        });
    });
}

// Splits everything the relay wrote back into frames, so the verdict can name them.
function parseFrames(buffer) {
    const frames = [];
    let offset = 0;

    while (offset + 2 <= buffer.length) {
        const opcode = buffer[offset] & 0x0f;
        let length = buffer[offset + 1] & 0x7f;
        let cursor = offset + 2;

        if (length === 126) {
            if (cursor + 2 > buffer.length) break;
            length = buffer.readUInt16BE(cursor);
            cursor += 2;
        }

        if (cursor + length > buffer.length) break;

        frames.push({
            opcode,
            payload: buffer.subarray(cursor, cursor + length),
            text: buffer.subarray(cursor, cursor + length).toString('utf8')
        });
        offset = cursor + length;
    }

    return frames;
}

// Opens one page-side connection, sends the given writes, and reports what came back.
function runCase(port, name, writes) {
    return new Promise(resolve => {
        const key = crypto.randomBytes(16).toString('base64');
        const socket = net.connect(port, '127.0.0.1');
        let buffer = Buffer.alloc(0);
        let upgraded = false;
        let closedByPeer = false;
        let error = null;

        socket.once('error', e => { error = e.code || e.message; });

        socket.once('connect', () => {
            socket.write(
                `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
                'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
                `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
                'Origin: https://matrix.tencent.com\r\n\r\n'
            );
        });

        socket.on('data', chunk => {
            buffer = Buffer.concat([buffer, chunk]);

            if (!upgraded) {
                const end = buffer.indexOf('\r\n\r\n');
                if (end < 0) return;
                upgraded = true;
                buffer = buffer.subarray(end + 4);
                // Send only after the 101 so the writes are not part of `head`.
                for (const write of writes) socket.write(write);
            }
        });

        socket.on('close', () => {
            closedByPeer = true;
        });

        setTimeout(() => {
            const frames = parseFrames(buffer);
            socket.destroy();
            resolve({
                name,
                upgraded,
                closedByPeer,
                error,
                frames: frames.map(f => ({
                    opcode: f.opcode,
                    label: f.opcode === 0x8 ? 'close' : f.opcode === 0x1 ? 'text' : String(f.opcode),
                    payload: f.payload,
                    text: f.text
                }))
            });
        }, 1200);
    });
}

const mock = `
function openUpstream(ip) {
    const secure = new (require('node:events').EventEmitter)();
    secure.pause = () => {};
    secure.resume = () => {};
    secure.destroy = () => { if (!secure.destroyed) { secure.destroyed = true; secure.emit('close'); } };
    secure.write = () => true;
    return Promise.resolve({ secure, ip, initial: Buffer.alloc(0) });
}
function unusedOriginalOpenUpstream(ip) {`;

(async () => {
    const port = await freePort();
    const code = source.replace(/^#![^\n]*\n/, '').replace(marker, mock);
    const child = spawn(process.execPath, ['-e', code], {
        env: { ...process.env, RELAY_PORT: String(port), RELAY_IDLE_MS: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        cwd: path.join(__dirname, '..', '..', 'src', 'relay')
    });

    let stdout = '';
    child.stdout.on('data', c => { stdout += String(c); });
    child.stderr.on('data', () => {});

    try {
        const deadline = Date.now() + 4000;
        while (!stdout.includes('relay listening') && Date.now() < deadline) await sleep(30);

        const results = [];

        // 1. A message split into two frames: text with FIN=0, then an empty
        //    continuation with FIN=1. Both are legal in RFC 6455.
        results.push(await runCase(port, 'fragmented message (text FIN=0 + continuation FIN=1)', [
            frame(0x1, 'hello ', { fin: false }),
            frame(0x0, 'world', { fin: true })
        ]));

        // 2. A clean close: code 1000 plus a reason. A conforming endpoint answers with
        //    a Close frame and the page's onclose then reports 1000.
        const closePayload = Buffer.alloc(2 + 3);
        closePayload.writeUInt16BE(1000, 0);
        closePayload.write('bye', 2);
        results.push(await runCase(port, 'page sends close(1000, "bye")', [frame(0x8, closePayload)]));

        // 3. A single complete text frame, as a control: this must work.
        results.push(await runCase(port, 'single text frame (control)', [frame(0x1, '{"fp":"x"}')]));

        process.stdout.write('\nrelay WebSocket edge cases\n\n');

        for (const r of results) {
            const closeFrame = r.frames.find(f => f.opcode === 0x8);
            process.stdout.write(`${r.name}\n`);
            process.stdout.write(`  upgraded:        ${r.upgraded}\n`);
            process.stdout.write(`  peer closed:     ${r.closedByPeer}\n`);
            process.stdout.write(`  socket error:    ${r.error || 'none'}\n`);
            process.stdout.write(`  frames back:     ${r.frames.length ? r.frames.map(f => f.label).join(', ') : 'none'}\n`);

            if (closeFrame) {
                const code = closeFrame.payload.length >= 2 ? closeFrame.payload.readUInt16BE(0) : null;
                process.stdout.write(`  close echo code: ${code}\n`);
            }
            process.stdout.write('\n');
        }

        const frag = results[0];
        const close = results[1];
        const control = results[2];

        process.stdout.write('verdicts\n');
        process.stdout.write(
            `  fragmented message accepted: ${frag.closedByPeer ? 'no — the page socket was closed instead' : 'yes'}\n`
        );
        process.stdout.write(
            `  close answered with a close frame: ${close.frames.some(f => f.opcode === 0x8) ? 'yes' : 'no'}\n`
        );
        // The mock upstream never echoes, so the control is healthy when the page socket
        // is still open rather than when frames come back.
        process.stdout.write(
            `  single frame leaves the connection open: ${control.closedByPeer ? 'no' : 'yes'}\n`
        );
    } finally {
        child.kill();
    }
})().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
