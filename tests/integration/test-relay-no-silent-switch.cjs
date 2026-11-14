// Regression test: a relay must not silently move a page connection onto a new
// upstream after frames have already been forwarded.
//
// The relay used to retry on a fresh address whenever an upstream closed without
// answering. That starts a brand-new server-side conversation, so every frame
// already forwarded belonged to a conversation that no longer existed and was
// never replayed. To the page nothing had changed — its socket stayed OPEN — while
// the server now held a session that had never seen the fingerprint or the captcha
// ticket. A subsequent detection frame was then judged against an empty session.
//
// The fix closes the page socket once frames have gone out, so the page reconnects
// and performs a complete handshake. This test asserts that no second upstream is
// opened in that situation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The mock upstream closes itself right after receiving the first frame, which is
// the exact condition that used to trigger a silent switch.
const MOCK = `let nextUpstream=0;
function openUpstream(ip) {
  const seq = ++nextUpstream;
  const secure = new (require('node:events').EventEmitter)();
  secure.pause = () => {};
  secure.resume = () => {};
  secure.destroy = () => { secure.emit('close'); };
  secure.write = encoded => {
    const decoded = decodeFrames(encoded).frames.map(f => f.payload.toString('utf8'));
    process.stderr.write('UPSTREAM_' + seq + '_WRITE:' + JSON.stringify(decoded) + '\\n');
    if (seq === 1) setTimeout(() => secure.emit('close'), 20);
    return true;
  };
  process.stderr.write('UPSTREAM_' + seq + '_OPEN\\n');
  return Promise.resolve({ secure, ip, initial: Buffer.alloc(0) });
}
function retiredOpenUpstream(ip) {`;

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

function frame(text) {
    const data = Buffer.from(text);
    const mask = crypto.randomBytes(4);
    return Buffer.concat([
        Buffer.from([0x81, 0x80 | data.length]),
        mask,
        Buffer.from(data.map((b, i) => b ^ mask[i % 4]))
    ]);
}

(async () => {
    const failures = [];
    const ok = m => process.stdout.write(`  ok    ${m}\n`);
    const fail = m => { failures.push(m); process.stdout.write(`  FAIL  ${m}\n`); };

    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'relay', 'server.cjs'), 'utf8');
    const code = source
        .replace(/^#![^\n]*\n/, '')
        .replace('function openUpstream(ip) {', MOCK);

    const port = await freePort();
    const child = spawn(process.execPath, ['-e', code], {
        env: { ...process.env, RELAY_PORT: String(port), RELAY_IDLE_MS: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: path.join(__dirname, '..', '..', 'src', 'relay')
    });

    let stderr = '';
    let stdout = '';
    child.stderr.on('data', b => { stderr += b.toString(); });
    child.stdout.on('data', b => { stdout += b.toString(); });

    try {
        let ready = false;
        for (let i = 0; i < 50; i++) {
            await sleep(40);
            if (stdout.includes('relay listening')) { ready = true; break; }
            if (child.exitCode !== null) throw new Error(stderr || 'relay exited');
        }
        assert.equal(ready, true, 'relay did not start');

        const socket = net.connect(port, '127.0.0.1');
        socket.on('error', () => {});
        await new Promise(resolve => socket.once('connect', resolve));

        const key = crypto.randomBytes(16).toString('base64');
        socket.write(
            `GET /ws HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\n` +
            `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\n` +
            'Sec-WebSocket-Version: 13\r\nOrigin: https://matrix.tencent.com\r\n\r\n'
        );

        let upgraded = false;
        let closed = false;
        let raw = '';
        socket.on('data', b => {
            raw += b.toString('latin1');
            if (raw.includes('101 Switching Protocols')) upgraded = true;
        });
        // Attached before anything can close it: the socket may be torn down the
        // instant the upstream dies.
        socket.on('close', () => { closed = true; });

        for (let i = 0; i < 40 && !upgraded; i++) await sleep(30);
        assert.equal(upgraded, true, 'local upgrade did not complete');

        // One frame goes to upstream #1, which then closes without answering.
        socket.write(frame('FIRST'));
        await sleep(700);

        if (stderr.includes('UPSTREAM_1_WRITE:["FIRST"]')) {
            ok('the first frame reached the original upstream');
        } else {
            fail(`the first frame never reached upstream #1: ${stderr.trim()}`);
        }

        if (!stderr.includes('UPSTREAM_2_OPEN')) {
            ok('no replacement upstream was opened after a frame was forwarded');
        } else {
            fail('a replacement upstream was opened, so the forwarded frame was lost');
        }

        // The page socket must be closed rather than left pointing at a session
        // that never received the handshake.
        if (closed) ok('the page socket is closed so the page can reconnect cleanly');
        else fail('the page socket was left open on an upstream without its handshake');
    } catch (error) {
        fail(error.message);
    } finally {
        child.kill();
    }

    if (failures.length) {
        process.stdout.write(`\n${failures.length} check(s) failed\n`);
        process.exitCode = 1;
    } else {
        process.stdout.write('\nall checks passed\n');
    }
})();
