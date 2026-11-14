// Verifies the relay honours the address the page names, against the real server.
//
// The page chooses its identity per load and passes it on the socket path. If the relay ignored it,
// the socket would carry a different address than the captcha ticket was issued for and every
// detection would be refused - with no visible cause. This drives the real socket and reads the
// frame the server answers.
const net = require('node:net');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { sleep } = require('../../tools/browser-harness.cjs');

const HOST = 'matrix.tencent.com';

// A fresh address per run. Measured against the real server: one address serves four handshakes and
// is refused from the fifth onwards, permanently, per address rather than per prefix. So a
// hardcoded address works a handful of times and then fails forever, which is why this is generated
// here and why the content script picks a new one on every load instead of restoring a stored value.
function freshIdentity() {
    const octet = () => 1 + Math.floor(Math.random() * 254);
    return `112.82.${octet()}.${octet()}`;
}

function encode(payload) {
    const data = Buffer.from(payload);
    const mask = crypto.randomBytes(4);
    const head = [0x81];
    if (data.length < 126) head.push(0x80 | data.length);
    else head.push(0x80 | 126, data.length >> 8, data.length & 0xff);
    const body = Buffer.from(data);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
    return Buffer.concat([Buffer.from(head), mask, body]);
}

function decode(buffer) {
    const out = [];
    let off = 0;
    while (off + 2 <= buffer.length) {
        let len = buffer[off + 1] & 0x7f;
        let cur = off + 2;
        if (len === 126) {
            if (cur + 2 > buffer.length) break;
            len = buffer.readUInt16BE(cur);
            cur += 2;
        }
        if (cur + len > buffer.length) break;
        out.push(buffer.slice(cur, cur + len).toString());
        off = cur + len;
    }
    return out;
}

// Opens a socket to the relay the way the shim does, with the identity on the path.
function probe(port, query, options = {}) {
    return new Promise(resolve => {
        const frames = [];
        const pathPart = query ? `/ws?xff=${query}` : '/ws';
        const origin = options.origin || `https://${HOST}`;
        const socket = net.connect(port, '127.0.0.1');
        const finish = () => {
            try { socket.destroy(); } catch (e) {}
            resolve({ frames });
        };
        const timer = setTimeout(finish, 20000);

        socket.on('error', () => { clearTimeout(timer); finish(); });

        socket.on('connect', () => {
            const key = crypto.randomBytes(16).toString('base64');
            socket.write(
                `GET ${pathPart} HTTP/1.1\r\n` +
                'Host: 127.0.0.1\r\n' +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                `Sec-WebSocket-Key: ${key}\r\n` +
                'Sec-WebSocket-Version: 13\r\n' +
                `Origin: ${origin}\r\n\r\n`
            );
        });

        let raw = Buffer.alloc(0);
        let upgraded = false;

        socket.on('data', chunk => {
            raw = Buffer.concat([raw, chunk]);

            if (!upgraded) {
                const idx = raw.indexOf('\r\n\r\n');
                if (idx === -1) return;
                const head = raw.slice(0, idx).toString();

                if (!/101/.test(head)) {
                    clearTimeout(timer);
                    try { socket.destroy(); } catch (e) {}
                    resolve({ frames, refused: head.split('\r\n')[0] });
                    return;
                }

                raw = raw.slice(idx + 4);
                upgraded = true;
                socket.write(encode(JSON.stringify({ fp: crypto.randomBytes(16).toString('hex') })));
                return;
            }

            for (const frame of decode(raw)) frames.push(frame);
            raw = Buffer.alloc(0);

            if (frames.length) { clearTimeout(timer); finish(); }
        });
    });
}

async function waitForRelay(port) {
    for (let i = 0; i < 40; i++) {
        try {
            if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true;
        } catch (error) {
            await sleep(250);
        }
    }
    return false;
}

(async () => {
    const port = 9475;
    const relay = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'relay', 'server.cjs')], {
        env: { ...process.env, RELAY_PORT: String(port) },
        stdio: 'ignore',
        windowsHide: true
    });

    const checks = [];
    const check = (name, ok, detail) => {
        checks.push(ok);
        console.log('%s %s%s', ok ? 'ok  ' : 'FAIL', name, detail ? '  - ' + detail : '');
    };

    try {
        const ready = await waitForRelay(port);
        check('relay started', ready);
        if (!ready) throw new Error('relay did not start');

        const identity = freshIdentity();
        const first = await probe(port, identity);
        const firstAnswer = first.frames.join(' ');
        check('the server answered the fingerprint frame', !!firstAnswer, firstAnswer.slice(0, 120));
        check('a named identity is accepted by the upstream', /success/.test(firstAnswer),
            firstAnswer.slice(0, 160));
        check('the answer reports the remaining allowance', /availableUses/.test(firstAnswer),
            firstAnswer.slice(0, 160));

        // The rule this test protects: the address the page picks has to be the one that reaches the
        // upstream. A relay that ignored the path and drew its own address would answer "success" on
        // every attempt, because each of its picks would be fresh. Driving the named address up to
        // its measured limit tells the two apart.
        let refusedAt = 0;
        for (let use = 2; use <= 5 && !refusedAt; use++) {
            const next = await probe(port, identity);
            const text = next.frames.join(' ');
            if (/Invalid request/.test(text)) refusedAt = use;
            await sleep(300);
        }
        check('the relay forwarded the named address, not one of its own', refusedAt === 5,
            refusedAt ? `refused at handshake ${refusedAt} (expected 5)` : 'never refused within 5');

        // The path is still gated: a query must not open the socket to any caller.
        const badOrigin = await probe(port, identity, { origin: 'https://evil.example' });
        check('a wrong origin is still refused', !!badOrigin.refused, badOrigin.refused || 'no refusal');

        // A malformed identity must be ignored rather than reaching the upstream header.
        const malformed = await probe(port, '1.2.3.4%0d%0aX-Injected:%201');
        const malformedAnswer = malformed.frames.join(' ');
        check('a malformed identity is ignored',
            !!malformedAnswer && !/X-Injected/.test(malformedAnswer),
            malformedAnswer.slice(0, 120));
    } finally {
        try { relay.kill(); } catch (error) {}

        const failed = checks.filter(ok => !ok).length;
        console.log('');
        if (failed) {
            console.error(`${failed}/${checks.length} relay identity checks failed`);
            process.exitCode = 1;
        } else {
            console.log(`PASS: ${checks.length}/${checks.length} relay identity checks`);
        }
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
