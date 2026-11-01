// Determines which frame the server rejects with "Invalid request".
//
// The page shows that message without saying which step failed, and the usage
// counter staying at 5 while it appears suggests the detection never started.
// This replays the three-frame handshake directly and reports the reply to each
// step, so the failing step is identified instead of inferred.
const net = require('node:net');
const crypto = require('node:crypto');

const PORT = Number(process.env.RELAY_PORT || 9420);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function maskedFrame(text) {
    const payload = Buffer.from(text);
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];

    const len = masked.length;
    const header = len < 126
        ? Buffer.from([0x81, 0x80 | len])
        : len < 65536
            ? Buffer.from([0x81, 0x80 | 126, (len >> 8) & 0xff, len & 0xff])
            : (() => {
                const h = Buffer.alloc(10);
                h[0] = 0x81; h[1] = 0x80 | 127;
                h.writeUInt32BE(0, 2);
                h.writeUInt32BE(len, 6);
                return h;
            })();

    return Buffer.concat([header, mask, masked]);
}

// Reads one server text frame from a growing buffer.
function readFrame(buffer) {
    if (buffer.length < 2) return null;

    let len = buffer[1] & 0x7f;
    let offset = 2;

    if (len === 126) {
        if (buffer.length < 4) return null;
        len = buffer.readUInt16BE(2);
        offset = 4;
    } else if (len === 127) {
        if (buffer.length < 10) return null;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
    }

    if (buffer.length < offset + len) return null;

    return {
        body: buffer.subarray(offset, offset + len).toString('utf8'),
        rest: buffer.subarray(offset + len)
    };
}

function session(label) {
    return new Promise(resolve => {
        const key = crypto.randomBytes(16).toString('base64');
        const socket = net.connect(PORT, '127.0.0.1');

        let buffer = Buffer.alloc(0);
        let upgraded = false;
        let settled = false;

        const replies = [];

        const done = () => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch (e) { }
            resolve(replies);
        };

        socket.setTimeout(20000, done);
        socket.on('error', done);

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

            if (!upgraded) {
                const head = buffer.toString('latin1');
                const end = head.indexOf('\r\n\r\n');
                if (end === -1) return;
                if (!/^HTTP\/1\.1 101/.test(head)) {
                    replies.push({ step: 'upgrade', body: head.split('\r\n')[0] });
                    done();
                    return;
                }
                upgraded = true;
                buffer = buffer.subarray(end + 4);
            }

            let frame;
            while ((frame = readFrame(buffer))) {
                buffer = frame.rest;
                replies.push({ step: `reply ${replies.length + 1}`, body: frame.body });
            }
        });

        // Step 1: fingerprint. Everything the site does starts here.
        setTimeout(() => socket.write(maskedFrame(JSON.stringify({ fp: crypto.randomBytes(16).toString('hex') }))), 300);

        // Step 2: exactly what the page sends after the captcha callback, but with
        // a deliberately invalid ticket, to see what the server says to it.
        setTimeout(() => {
            socket.write(maskedFrame(JSON.stringify({ ticket: 'invalid-ticket-for-probe', randstr: 'probe' })));
        }, 2500);

        // Step 3: a detection payload, in case the server ignores a bad ticket and
        // only refuses at the point where it needs a valid one.
        setTimeout(() => {
            socket.write(maskedFrame(JSON.stringify({ text: '这是一段用于诊断的测试文本，'.repeat(30) })));
        }, 4500);

        setTimeout(done, 9000);
    });
}

(async () => {
    process.stdout.write(`relay on 127.0.0.1:${PORT}\n`);

    const replies = await session('probe');

    for (const r of replies) {
        process.stdout.write(`  ${r.step.padEnd(9)} ${r.body}\n`);
    }

    const rejected = replies.filter(r => /"failed"/.test(r.body));

    process.stdout.write('\n');
    if (!replies.length) {
        process.stdout.write('no reply at all: the relay did not answer\n');
    } else if (rejected.length) {
        process.stdout.write(`the server rejected ${rejected.length} frame(s); see the failed line above\n`);
    } else {
        process.stdout.write('nothing was rejected in this run\n');
    }
})();
