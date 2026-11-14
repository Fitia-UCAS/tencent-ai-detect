// Measures the round trip of the first fingerprint frame, several times.
//
// The relay's upstream can be slow, and the page is strict about timing: it
// abandons a detection after 15s and reconnects after 5s. A first-frame delay that
// approaches those numbers would make the handshake race the page's own timers,
// so the delay is measured rather than guessed.
const net = require('node:net');
const crypto = require('node:crypto');

const PORT = Number(process.env.RELAY_PORT || 9420);
const ROUNDS = Number(process.argv[2] || 5);
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

function once() {
    return new Promise(resolve => {
        const key = crypto.randomBytes(16).toString('base64');
        const socket = net.connect(PORT, '127.0.0.1');

        let buffer = Buffer.alloc(0);
        let upgradedAt = 0;
        let sentAt = 0;
        let done = false;

        const finish = r => {
            if (done) return;
            done = true;
            try { socket.destroy(); } catch (e) { }
            resolve(r);
        };

        socket.setTimeout(30000, () => finish({ error: 'timeout' }));
        socket.on('error', e => finish({ error: e.message }));

        socket.once('connect', () => {
            socket.write(
                'GET /ws HTTP/1.1\r\n' +
                `Host: 127.0.0.1:${PORT}\r\n` +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                `Sec-WebSocket-Key: ${key}\r\n` +
                'Sec-WebSocket-Version: 13\r\n' +
                'Origin: https://matrix.tencent.com\r\n\r\n'
            );
        });

        socket.on('data', chunk => {
            buffer = Buffer.concat([buffer, chunk]);

            if (!upgradedAt) {
                const head = buffer.toString('latin1');
                const end = head.indexOf('\r\n\r\n');
                if (end === -1) return;
                upgradedAt = Date.now();
                buffer = buffer.subarray(end + 4);
                sentAt = Date.now();
                socket.write(maskedFrame(JSON.stringify({ fp: crypto.randomBytes(16).toString('hex') })));
                return;
            }

            if (buffer.length < 2) return;

            let len = buffer[1] & 0x7f;
            let offset = 2;
            if (len === 126) {
                if (buffer.length < 4) return;
                len = buffer.readUInt16BE(2);
                offset = 4;
            }
            if (buffer.length < offset + len) return;

            const body = buffer.subarray(offset, offset + len).toString('utf8');
            finish({
                upgradeMs: sentAt - upgradedAt,
                firstFrameMs: Date.now() - sentAt,
                body
            });
        });

        socket.on('close', () => finish({ error: 'closed before a frame arrived' }));
    });
}

(async () => {
    process.stdout.write(`measuring first-frame round trip over ${ROUNDS} connections\n`);

    const samples = [];

    for (let i = 0; i < ROUNDS; i++) {
        const r = await once();

        if (r.error) {
            process.stdout.write(`  ${i + 1}  ERROR  ${r.error}\n`);
        } else {
            samples.push(r.firstFrameMs);
            const accepted = /"status"\s*:\s*"success"/.test(r.body);
            process.stdout.write(`  ${i + 1}  ${String(r.firstFrameMs).padStart(5)}ms  ${accepted ? 'ACCEPT' : 'REFUSE'}  ${r.body}\n`);
        }

        await sleep(600);
    }

    if (samples.length) {
        samples.sort((a, b) => a - b);
        const min = samples[0];
        const max = samples[samples.length - 1];
        const median = samples[Math.floor(samples.length / 2)];

        process.stdout.write(`\nfirst frame: min ${min}ms, median ${median}ms, max ${max}ms\n`);

        if (median > 3000) {
            process.stdout.write('the handshake is slow enough to race the page 5s reconnect / 15s detect timeout\n');
        } else if (max > 5000) {
            process.stdout.write('usually fast, but the worst case crosses the page 5s reconnect timer\n');
        } else {
            process.stdout.write('the handshake is fast enough for the page timers\n');
        }
    }
})();
