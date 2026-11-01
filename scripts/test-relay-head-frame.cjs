// Offline regression: the first browser frame may arrive in the same TCP write
// as the HTTP Upgrade request. The relay must forward it exactly once.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const source = fs.readFileSync(path.join(__dirname, 'relay.cjs'), 'utf8');
const marker = 'function openUpstream(ip) {';
assert.equal(source.split(marker).length, 2, 'expected one upstream function');
const PORT = 0;
const ROUNDS = 4;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function maskedFrame(text) {
    const payload = Buffer.from(text);
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
    return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
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

function attempt(port) {
    return new Promise((resolve, reject) => {
        const key = crypto.randomBytes(16).toString('base64');
        const socket = net.connect(port, '127.0.0.1');
        let buffer = Buffer.alloc(0);
        let upgraded = false;
        let settled = false;

        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            error ? reject(error) : resolve(result);
        };

        const timer = setTimeout(() => finish(new Error('head-frame echo timed out')), 2500);
        socket.once('error', error => finish(error));
        socket.once('connect', () => {
            const upgrade =
                `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
                'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
                `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
                'Origin: https://matrix.tencent.com\r\n\r\n';
            const firstFrame = maskedFrame(JSON.stringify({ fp: `probe-${crypto.randomBytes(6).toString('hex')}` }));
            // One write deliberately places the first frame in Node's upgrade `head`.
            socket.write(Buffer.concat([Buffer.from(upgrade, 'latin1'), firstFrame]));
        });

        socket.on('data', chunk => {
            buffer = Buffer.concat([buffer, chunk]);
            if (!upgraded) {
                const end = buffer.indexOf('\r\n\r\n');
                if (end < 0) return;
                const headers = buffer.subarray(0, end).toString('latin1');
                if (!/^HTTP\/1\.1 101 Switching Protocols/m.test(headers)) {
                    finish(new Error(`upgrade rejected: ${headers.split('\r\n')[0]}`));
                    return;
                }
                upgraded = true;
                buffer = buffer.subarray(end + 4);
            }

            if (buffer.length < 2) return;
            let length = buffer[1] & 0x7f;
            let offset = 2;
            if (length === 126) {
                if (buffer.length < 4) return;
                length = buffer.readUInt16BE(2);
                offset = 4;
            }
            if (buffer.length < offset + length) return;
            const payload = buffer.subarray(offset, offset + length).toString('utf8');
            finish(null, { upgraded, payload });
        });
    });
}

const mock = `
function openUpstream(ip) {
    const secure = new (require('node:events').EventEmitter)();
    secure.pause = () => {};
    secure.resume = () => {};
    secure.destroy = () => { if (!secure.destroyed) { secure.destroyed = true; secure.emit('close'); } };
    secure.write = data => {
        const labels = decodeFrames(data).frames.map(frame => labelFramePayload(frame.payload));
        process.stderr.write('MOCK_UPSTREAM_FRAMES:' + labels.join(',') + '\\n');
        setImmediate(() => secure.emit('data', Buffer.from([0x81, 0x02, 0x4f, 0x4b])));
        return true;
    };
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
        cwd: __dirname
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });

    try {
        const deadline = Date.now() + 4000;
        while (!stdout.includes('relay listening') && Date.now() < deadline) {
            if (child.exitCode !== null) throw new Error(`relay exited: ${stderr}`);
            await sleep(30);
        }
        assert.match(stdout, /relay listening/);

        for (let i = 0; i < ROUNDS; i++) {
            const result = await attempt(port);
            assert.equal(result.upgraded, true);
            assert.equal(result.payload, 'OK');
        }

        // The mock writes its frame marker to a child-process stderr pipe.
        // The client can receive the echoed frame before the parent process has
        // drained that pipe, so wait briefly for all markers before asserting.
        const logDeadline = Date.now() + 1200;
        let forwarded = [];
        while (Date.now() < logDeadline) {
            forwarded = stderr.split('\n').filter(line => line === 'MOCK_UPSTREAM_FRAMES:fp');
            if (forwarded.length >= ROUNDS) break;
            await sleep(10);
        }
        assert.equal(forwarded.length, ROUNDS, `expected ${ROUNDS} forwarded fp frames, got ${forwarded.length}\n${stderr}`);
        process.stdout.write(`PASS: ${ROUNDS}/${ROUNDS} upgrade+first-frame writes reached the local mock upstream exactly once\n`);
    } finally {
        child.kill();
    }
})().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
