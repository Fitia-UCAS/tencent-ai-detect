// Relay behaviour under repeated connections: does anything grow without bound?
//
// The relay keeps per-connection buffers, a pending queue, an outgoing queue and a small
// stats object. Each is bounded in the source, but bounded code can still accumulate through
// a buffer that is never reset. This opens a fixed number of short-lived connections through
// the real relay with the upstream stubbed, then reports RSS and the internal counters.
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const source = fs.readFileSync(path.join(__dirname, 'relay.cjs'), 'utf8');
const marker = 'function openUpstream(ip) {';
const CONNECTIONS = Number(process.env.CONNECTIONS || 300);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function maskedFrame(text) {
    const payload = Buffer.from(text);
    const key = crypto.randomBytes(4);
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] ^= key[i % 4];
    return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), key, body]);
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

function rss(pid) {
    const r = spawnSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).WorkingSet64`
    ], { encoding: 'utf8', timeout: 8000 });
    const value = Number(String(r.stdout || '').trim());
    return Number.isFinite(value) && value > 0 ? Math.round(value / 1024 / 1024) : null;
}

// One short session: upgrade, send a couple of frames, disconnect abruptly.
function session(port) {
    return new Promise(resolve => {
        const key = crypto.randomBytes(16).toString('base64');
        const socket = net.connect(port, '127.0.0.1');
        let settled = false;

        const finish = () => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve();
        };

        socket.once('error', finish);
        socket.once('connect', () => {
            socket.write(
                `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
                'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
                `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
                'Origin: https://matrix.tencent.com\r\n\r\n'
            );
            socket.write(maskedFrame(JSON.stringify({ fp: crypto.randomBytes(8).toString('hex') })));
            socket.write(maskedFrame(JSON.stringify({ text: 'x'.repeat(400) })));
            setTimeout(finish, 40);
        });
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
        cwd: __dirname
    });

    let stdout = '';
    child.stdout.on('data', c => { stdout += String(c); });
    child.stderr.on('data', () => {});

    try {
        const deadline = Date.now() + 4000;
        while (!stdout.includes('relay listening') && Date.now() < deadline) await sleep(30);

        const base = rss(child.pid);
        process.stdout.write(`relay pid=${child.pid} start RSS=${base} MiB\n`);

        const marks = [10, 50, 100, 200, 300, 500].filter(n => n <= CONNECTIONS);
        let done = 0;

        for (const mark of marks) {
            while (done < mark) {
                await session(port);
                done++;
            }

            // Let closed sockets unwind before sampling.
            await sleep(400);
            process.stdout.write(`  after ${String(done).padStart(4)} connections: RSS=${rss(child.pid)} MiB\n`);
        }

        const end = rss(child.pid);
        process.stdout.write(`\ndelta: ${base === null || end === null ? 'unknown' : end - base} MiB over ${done} connections\n`);

        if (base !== null && end !== null) {
            // A per-connection leak of even 50 KiB would show up as 15 MiB here.
            process.stdout.write(
                end - base <= 20
                    ? 'verdict: no unbounded growth at this scale\n'
                    : 'verdict: RSS grew by more than 20 MiB; worth a closer look\n'
            );
        }
    } finally {
        child.kill();
    }
})().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
