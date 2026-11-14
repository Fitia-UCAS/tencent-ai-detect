// Offline regression: error+close must trigger only one replacement upstream.
// The upstream is a local EventEmitter; this test makes no external requests.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const file = path.join(__dirname, '..', '..', 'src', 'relay', 'server.cjs');
const src = fs.readFileSync(file, 'utf8');
const marker = 'function openUpstream(ip) {';

if (!src.includes(marker)) throw Error('function absent');

// Replaces the upstream factory with one that fails its first connection, so the relay's retry
// path is the thing under test rather than the network.
const mock = `let attemptCounter = 0;
function openUpstream(ip) {
    const n = ++attemptCounter;
    process.stderr.write('MOCK_OPEN_' + n + '\\n');
    const secure = new (require('node:events').EventEmitter)();
    secure.write = () => true;
    secure.pause = () => {};
    secure.resume = () => {};
    secure.destroy = () => {};
    if (n === 1) {
        setTimeout(() => {
            secure.emit('error', new Error('synthetic TLS reset'));
            secure.emit('close');
        }, 30);
    }
    return Promise.resolve({ secure, ip, initial: Buffer.alloc(0) });
}
function unusedOriginalOpenUpstream(ip) {`;

const code = src.replace(/^#![^\n]*\n/, '').replace(marker, mock);

(async () => {
    const port = await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const assigned = server.address().port;
            server.close(() => resolve(assigned));
        });
        server.on('error', reject);
    });

    const child = spawn(process.execPath, ['-e', code], {
        env: { ...process.env, RELAY_PORT: String(port), RELAY_IDLE_MS: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: path.join(__dirname, '..', '..', 'src', 'relay')
    });

    let logs = '';
    let ready = false;
    child.stderr.on('data', chunk => { logs += chunk.toString(); });
    child.stdout.on('data', chunk => {
        if (chunk.toString().includes('relay listening')) ready = true;
    });

    try {
        for (let i = 0; i < 50 && !ready; i += 1) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        if (!ready) throw Error('no relay start');

        const socket = net.connect(port, '127.0.0.1');
        socket.on('error', () => {});
        await new Promise(resolve => socket.once('connect', resolve));

        socket.write(
            'GET /ws HTTP/1.1\r\n'
            + `Host: 127.0.0.1:${port}\r\n`
            + 'Connection: Upgrade\r\n'
            + 'Upgrade: websocket\r\n'
            + 'Sec-WebSocket-Version: 13\r\n'
            + `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n`
            + 'Origin: https://matrix.tencent.com\r\n\r\n'
        );

        await new Promise(resolve => setTimeout(resolve, 400));
        socket.destroy();

        const opens = logs.split('\n').filter(line => line.startsWith('MOCK_OPEN_'));
        if (opens.join(',') !== 'MOCK_OPEN_1,MOCK_OPEN_2') {
            throw new Error('duplicate retry: ' + JSON.stringify(opens));
        }

        console.log('PASS: error+close causes exactly one retry');
    } finally {
        child.kill();
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
