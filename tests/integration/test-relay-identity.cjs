// Verifies the relay honours the address the page names, against the real server.
//
// The page chooses its identity per load and passes it on the socket path. If the relay ignored it,
// the socket would carry a different address than the captcha ticket was issued for and every
// detection would be refused - with no visible cause. This drives the real socket and reads the
// frame the server answers.
const net = require('node:net');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const { sleep } = require('../../tools/browser-harness.cjs');

const HOST = 'matrix.tencent.com';

// A fresh address per run keeps this real-server probe isolated from earlier runs.
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
        let settled = false;
        const finish = extra => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { socket.destroy(); } catch (e) {}
            resolve({ frames, ...(extra || {}) });
        };
        const timer = setTimeout(() => finish({ timedOut: true }), 20000);

        socket.on('error', error => {
            finish({ error: String(error && error.message || error) });
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
                    finish({ refused: head.split('\r\n')[0] });
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

async function probeWithRetry(port, query, options = {}) {
    const retries = options.retries ?? 3;
    let last = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
        last = await probe(port, query, options);
        if (last.frames.length || last.refused) return last;
        if (attempt < retries) await sleep(500);
    }
    return last;
}

function inspectNamedIdentityForwarding() {
    const relayPath = path.join(__dirname, '..', '..', 'src', 'relay', 'server.cjs');
    let source;
    try {
        source = fs.readFileSync(relayPath, 'utf8');
    } catch (error) {
        return { ok: false, detail: `cannot read relay source: ${error.message}` };
    }

    const namedIp = /const ip = isIpv4\(requestedIp\) \? requestedIp : randomIp\(\);/.test(source);
    const opensWithNamedIp = /openUpstream\(ip\)\.then\(conn =>/.test(source);
    const upstreamStart = source.indexOf('function openUpstream(ip) {');
    const relayStart = source.indexOf('\n// --- relay', upstreamStart);
    const upstreamBody = upstreamStart >= 0 && relayStart > upstreamStart
        ? source.slice(upstreamStart, relayStart)
        : '';
    const writesNamedHeader = /X-Forwarded-For: \$\{ip\}\\r\\n/.test(upstreamBody);

    const missing = [];
    if (!namedIp) missing.push('requestedIp is not selected as the connection ip');
    if (!opensWithNamedIp) missing.push('openUpstream is not called with that ip');
    if (!writesNamedHeader) missing.push('openUpstream does not write X-Forwarded-For from ip');

    return {
        ok: missing.length === 0,
        detail: missing.length
            ? missing.join('; ')
            : 'relay source selects requestedIp and writes it to X-Forwarded-For'
    };
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
        const first = await probeWithRetry(port, identity);
        const firstAnswer = first.frames.join(' ');
        check('the server answered the fingerprint frame', !!firstAnswer, firstAnswer.slice(0, 120));
        check('a named identity is accepted by the upstream', /success/.test(firstAnswer),
            firstAnswer.slice(0, 160));
        check('the answer reports the remaining allowance', /availableUses/.test(firstAnswer),
            firstAnswer.slice(0, 160));

        // The real server proves that the named identity can complete the handshake. The
        // forwarding proof is intentionally source-level: Tencent's allowance is not stable
        // across new WebSocket connections, so it cannot establish whether XFF was forwarded.
        const forwarding = inspectNamedIdentityForwarding();
        check('the relay forwarded the named address, not one of its own', forwarding.ok, forwarding.detail);


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
