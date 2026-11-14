// Tests whether sending the first WebSocket frame immediately after the upgrade
// request (as the page does) breaks the relay.
//
// The page sends {fp} the instant the socket opens, so the upgrade request and
// the first frame can land in the same TCP segment. A relay that only starts
// parsing frames after it has finished its own upstream round trip can mis-frame
// that early data and forward something the server rejects with a bare
// "Invalid request".
const net = require('node:net');
const crypto = require('node:crypto');

const PORT = 9420;
const ROUNDS = Number(process.argv[2] || 8);
const SAME_SEGMENT = process.argv.includes('--same-segment');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function maskedFrame(text) {
    const payload = Buffer.from(text);
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];

    const len = masked.length;
    const header = len < 126
        ? Buffer.from([0x81, 0x80 | len])
        : Buffer.from([0x81, 0x80 | 126, (len >> 8) & 0xff, len & 0xff]);

    return Buffer.concat([header, mask, masked]);
}

function attempt() {
    return new Promise(resolve => {
        const key = crypto.randomBytes(16).toString('base64');
        const socket = net.connect(PORT, '127.0.0.1');

        let buffer = Buffer.alloc(0);
        let upgraded = false;
        let settled = false;

        const done = r => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch (e) { }
            resolve(r);
        };

        socket.setTimeout(12000, () => done({ ok: false, reason: 'timeout' }));
        socket.on('error', e => done({ ok: false, reason: e.message }));

        const upgrade =
            'GET /ws HTTP/1.1\r\n' +
            `Host: 127.0.0.1:${PORT}\r\n` +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Key: ${key}\r\n` +
            'Sec-WebSocket-Version: 13\r\n' +
            'Origin: https://matrix.tencent.com\r\n\r\n';

        const frame = maskedFrame(JSON.stringify({ fp: crypto.randomBytes(16).toString('hex') }));

        socket.once('connect', () => {
            if (SAME_SEGMENT) {
                // Exactly what a page can produce: one write, upgrade + frame.
                socket.write(Buffer.concat([Buffer.from(upgrade, 'latin1'), frame]));
            } else {
                socket.write(upgrade);
            }
        });

        socket.on('data', chunk => {
            buffer = Buffer.concat([buffer, chunk]);

            if (!upgraded) {
                const head = buffer.toString('latin1');
                const end = head.indexOf('\r\n\r\n');
                if (end === -1) return;
                if (!/^HTTP\/1\.1 101/.test(head)) {
                    done({ ok: false, reason: head.split('\r\n')[0] });
                    return;
                }
                upgraded = true;
                buffer = buffer.subarray(end + 4);
                if (!SAME_SEGMENT) socket.write(frame);
                return;
            }

            if (buffer.length < 2) return;
            const len = buffer[1] & 0x7f;
            if (len > 125 || buffer.length < 2 + len) return;

            done({ ok: true, body: buffer.subarray(2, 2 + len).toString('utf8') });
        });

        socket.on('close', () => done({ ok: false, reason: 'closed early' }));
    });
}

(async () => {
    process.stdout.write(`mode: ${SAME_SEGMENT ? 'upgrade+frame in one write (page-like)' : 'frame after 101'}\n`);

    let accepted = 0;
    let refused = 0;

    for (let i = 0; i < ROUNDS; i++) {
        const r = await attempt();

        if (!r.ok) {
            process.stdout.write(`  ${i + 1}  ERROR   ${r.reason}\n`);
        } else if (/"status"\s*:\s*"success"/.test(r.body)) {
            accepted += 1;
            process.stdout.write(`  ${i + 1}  ACCEPT  ${r.body}\n`);
        } else {
            refused += 1;
            process.stdout.write(`  ${i + 1}  REFUSE  ${r.body}\n`);
        }

        await sleep(500);
    }

    process.stdout.write(`\naccepted ${accepted}/${ROUNDS}, refused ${refused}\n`);
})();
