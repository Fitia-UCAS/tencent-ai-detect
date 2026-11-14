// Samples the relay's address pool: opens N fresh connections, sends the same
// fingerprint frame, and tallies how many are accepted.
//
// The site answers a refused client address with a bare "Invalid request" on the
// very first frame, and the relay picks a new address per connection, so a single
// attempt tells you nothing. Only a sample shows whether the pool works at all.
//
// Usage:
//   node scripts/diag-ip-pool.cjs [count]
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const COUNT = Number(process.argv[2] || 12);
const RELAY_PORT = 9420;

// Minimal RFC 6455 client: the relay only needs a valid upgrade and one text
// frame. Node's WebSocket would add another layer of buffering for no benefit.
function connectOnce(timeoutMs = 12000) {
    return new Promise(resolve => {
        const key = Buffer.from('0123456789abcdef').toString('base64');
        const socket = net.connect(RELAY_PORT, '127.0.0.1');
        let buffer = Buffer.alloc(0);
        let settled = false;
        let upgraded = false;

        const done = result => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch (e) { }
            resolve(result);
        };

        const timer = setTimeout(() => done({ ok: false, reason: 'timeout' }), timeoutMs);

        socket.once('connect', () => {
            socket.write(
                'GET /ws HTTP/1.1\r\n' +
                'Host: 127.0.0.1:9420\r\n' +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                `Sec-WebSocket-Key: ${key}\r\n` +
                'Sec-WebSocket-Version: 13\r\n' +
                'Origin: https://matrix.tencent.com\r\n\r\n'
            );
        });

        socket.on('data', chunk => {
            buffer = Buffer.concat([buffer, chunk]);

            if (!upgraded) {
                const head = buffer.toString('latin1');
                const end = head.indexOf('\r\n\r\n');
                if (end === -1) return;
                if (!/^HTTP\/1\.1 101/.test(head)) {
                    clearTimeout(timer);
                    done({ ok: false, reason: `upgrade ${head.split('\r\n')[0]}` });
                    return;
                }
                upgraded = true;
                buffer = buffer.subarray(end + 4);

                // One masked text frame carrying the fingerprint.
                const payload = Buffer.from(JSON.stringify({ fp: 'a5515fd229f8ecfa446b3239d19e00e0' }));
                const mask = Buffer.from([1, 2, 3, 4]);
                const masked = Buffer.from(payload);
                for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];

                const len = masked.length;
                const header = len < 126
                    ? Buffer.from([0x81, 0x80 | len])
                    : Buffer.from([0x81, 0x80 | 126, (len >> 8) & 0xff, len & 0xff]);

                socket.write(Buffer.concat([header, mask, masked]));
                return;
            }

            // Read one server frame (unmasked, small enough for the short form).
            if (buffer.length < 2) return;
            const len = buffer[1] & 0x7f;
            if (len > 125) return done({ ok: false, reason: 'frame too long for probe' });
            if (buffer.length < 2 + len) return;

            const body = buffer.subarray(2, 2 + len).toString('utf8');
            clearTimeout(timer);
            done({ ok: true, body });
        });

        socket.on('error', error => {
            clearTimeout(timer);
            done({ ok: false, reason: error.message });
        });

        socket.on('close', () => {
            clearTimeout(timer);
            done({ ok: false, reason: 'closed before a frame arrived' });
        });
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function relayHealth() {
    return new Promise(resolve => {
        const socket = net.connect(RELAY_PORT, '127.0.0.1');
        let buffer = '';
        socket.setTimeout(1500);
        socket.once('connect', () => socket.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
        socket.on('data', c => { buffer += c; });
        socket.on('close', () => resolve({ ok: true, body: buffer }));
        socket.on('timeout', () => { socket.destroy(); resolve({ ok: false }); });
        socket.on('error', () => resolve({ ok: false }));
    });
}

(async () => {
    const health = await relayHealth();

    if (!health.ok) {
        process.stdout.write('relay is not running. start it first:\n  npm run relay\n');
        process.exitCode = 1;
        return;
    }

    const accepted = [];
    const refused = [];
    const broken = [];

    for (let i = 0; i < COUNT; i++) {
        const result = await connectOnce();

        if (!result.ok) {
            broken.push(result.reason);
            process.stdout.write(`  ${String(i + 1).padStart(2)}  ERROR   ${result.reason}\n`);
            continue;
        }

        if (/"status"\s*:\s*"success"/.test(result.body)) {
            accepted.push(result.body);
            process.stdout.write(`  ${String(i + 1).padStart(2)}  ACCEPT  ${result.body}\n`);
        } else {
            refused.push(result.body);
            process.stdout.write(`  ${String(i + 1).padStart(2)}  REFUSE  ${result.body}\n`);
        }

        // Space them out: a burst looks like an attack and may skew the result.
        await sleep(400);
    }

    process.stdout.write(`\naccepted ${accepted.length}/${COUNT}, refused ${refused.length}, errors ${broken.length}\n`);

    if (accepted.length === COUNT) {
        process.stdout.write('every sampled address is accepted: the pool is not the problem\n');
    } else if (accepted.length === 0) {
        process.stdout.write('no sampled address is accepted: the pool is unusable right now\n');
    } else {
        process.stdout.write('partial: some addresses are accepted and some are refused, so a single attempt is unreliable\n');
    }
})();
