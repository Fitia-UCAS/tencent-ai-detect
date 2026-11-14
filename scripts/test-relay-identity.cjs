// Verifies the relay honours the address the page names, end to end against the real server.
//
// The page chooses its identity per load and passes it on the socket path. If the relay ignored it,
// the socket would carry a different address than the captcha ticket was issued for and every
// detection would be refused - with no visible cause. This drives the real socket and inspects the
// frame the server answers.
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { sleep } = require('./browser-harness.cjs');

const RELAY_PORT = 9471;
const HOST = 'matrix.tencent.com';

// A fresh address per run. Measured against the real server: one address serves four handshakes and
// is refused from the fifth onwards, permanently - per address, not per prefix. So a hardcoded
// address works a handful of times and then fails forever, which is why this is generated here and
// why content.js picks a new one on every load instead of restoring the stored value.
function freshIdentity() {
    const octet = () => 1 + Math.floor(Math.random() * 254);
    return `112.82.${octet()}.${octet()}`;
}

function encode(payload) {
    const data = Buffer.from(payload);
    const mask = crypto.randomBytes(4);
    const head = [];
    head.push(0x81);
    if (data.length < 126) head.push(0x80 | data.length);
    else { head.push(0x80 | 126, data.length >> 8, data.length & 0xff); }
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
function probe(query, options = {}) {
    return new Promise(resolve => {
        const frames = [];
        const pathPart = query ? `/ws?xff=${query}` : '/ws';
        const origin = options.origin || `https://${HOST}`;
        const socket = net.connect(RELAY_PORT, '127.0.0.1');
        const timer = setTimeout(() => {
            try { socket.destroy(); } catch (e) {}
            resolve({ frames, done: false });
        }, 20000);

        socket.on('error', error => {
            clearTimeout(timer);
            resolve({ frames, error: error.message });
        });

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

            if (frames.length) {
                clearTimeout(timer);
                try { socket.destroy(); } catch (e) {}
                resolve({ frames, done: true });
            }
        });
    });
}

(async () => {
    const relay = spawn(process.execPath, [path.join(__dirname, 'relay.cjs')], {
        env: { ...process.env, RELAY_PORT: String(RELAY_PORT) },
        stdio: 'ignore',
        windowsHide: true
    });

    const checks = [];
    const check = (name, ok, detail) => {
        checks.push(ok);
        console.log('%s %s%s', ok ? 'ok  ' : 'FAIL', name, detail ? '  - ' + detail : '');
    };

    try {
        // Wait for the port rather than sleeping a fixed time.
        let ready = false;
        for (let i = 0; i < 40 && !ready; i++) {
            try {
                const r = await fetch(`http://127.0.0.1:${RELAY_PORT}/health`);
                ready = r.ok;
            } catch (error) {
                await sleep(250);
            }
        }
        check('relay started', ready);
        if (!ready) throw new Error('relay did not start');

        const IDENTITY = freshIdentity();
        const named = await probe(IDENTITY);
        const answer = named.frames.join(' ');
        check('the server answered the fingerprint frame', !!answer, answer.slice(0, 120));
        check('a named identity is accepted by the upstream', /success/.test(answer), answer.slice(0, 160));
        check('the answer reports the remaining allowance', /availableUses/.test(answer), answer.slice(0, 160));

        // The rule this test protects: the identity content.js picks has to be the one that reaches
        // the upstream. A relay that ignored the path and drew its own address would still answer
        // "success" on every attempt, because each of its picks would be fresh. Driving the named
        // address up to its measured limit tells the two apart: only a relay that forwards the named
        // address will start being refused on the fifth handshake.
        let refusedAt = 0;
        for (let use = 2; use <= 5 && !refusedAt; use++) {
            const next = await probe(IDENTITY);
            const text = next.frames.join(' ');
            if (/Invalid request/.test(text)) refusedAt = use;
            await sleep(300);
        }
        check(
            'the relay forwarded the named address, not one of its own',
            refusedAt === 5,
            refusedAt ? `refused at handshake ${refusedAt} (expected 5)` : 'never refused within 5'
        );

        // The path is still gated: a query must not open the socket to any caller.
        const badOrigin = await probe(IDENTITY, { origin: 'https://evil.example' });
        check('a wrong origin is still refused', !!badOrigin.refused, badOrigin.refused || 'no refusal');

        // A malformed identity must be ignored rather than reaching the upstream header.
        const malformed = await probe('1.2.3.4%0d%0aX-Injected:%201');
        const malformedAnswer = malformed.frames.join(' ');
        check(
            'a malformed identity is ignored',
            !!malformedAnswer && !/X-Injected/.test(malformedAnswer),
            malformedAnswer.slice(0, 120)
        );
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
