// Smoke test for the local relay: connect like the page does, send {fp}, and
// check that the upstream verdict comes back accepted.
const net = require('node:net');
const crypto = require('node:crypto');

const PORT = Number(process.env.RELAY_PORT || 9420);

function encode(payload, masked) {
    const data = Buffer.from(payload);
    const head = [0x81];
    const bit = masked ? 0x80 : 0;

    if (data.length < 126) head.push(bit | data.length);
    else { head.push(bit | 126, data.length >> 8, data.length & 0xff); }

    const header = Buffer.from(head);
    if (!masked) return Buffer.concat([header, data]);

    const mask = crypto.randomBytes(4);
    const body = Buffer.from(data);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
    return Buffer.concat([header, mask, body]);
}

function decode(buffer) {
    const frames = [];
    let off = 0;
    while (off + 2 <= buffer.length) {
        const opcode = buffer[off] & 0x0f;
        let len = buffer[off + 1] & 0x7f;
        let cur = off + 2;
        if (len === 126) { if (cur + 2 > buffer.length) break; len = buffer.readUInt16BE(cur); cur += 2; }
        else if (len === 127) { if (cur + 8 > buffer.length) break; len = Number(buffer.readBigUInt64BE(cur)); cur += 8; }
        if (cur + len > buffer.length) break;
        frames.push({ opcode, payload: buffer.slice(cur, cur + len).toString() });
        off = cur + len;
    }
    return frames;
}

function attempt() {
    return new Promise(resolve => {
        const key = crypto.randomBytes(16).toString('base64');
        const socket = net.connect(PORT, '127.0.0.1', () => {
            socket.write(
                `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\n` +
                `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: https://matrix.tencent.com\r\n\r\n`
            );
        });

        let raw = Buffer.alloc(0);
        let upgraded = false;
        const frames = [];
        let done = false;

        const finish = () => {
            if (done) return;
            done = true;
            try { socket.destroy(); } catch (e) {}
            resolve(frames);
        };

        socket.on('error', () => finish());

        socket.on('data', chunk => {
            raw = Buffer.concat([raw, chunk]);

            if (!upgraded) {
                const idx = raw.indexOf('\r\n\r\n');
                if (idx === -1) return;
                const head = raw.slice(0, idx).toString();
                if (!/ 101 /.test(head.split('\r\n')[0])) { finish(); return; }
                raw = raw.slice(idx + 4);
                upgraded = true;
                socket.write(encode(JSON.stringify({ fp: crypto.randomBytes(16).toString('hex') }), true));
                setTimeout(finish, 10000);
                return;
            }

            decode(raw).forEach(f => frames.push(f.payload));
        });
    });
}

(async () => {
    const rounds = [];
    for (let i = 0; i < 4; i++) rounds.push(await attempt());

    rounds.forEach((frames, i) => {
        const first = frames[0] || '(no frame)';
        let verdict = first;
        try {
            const d = JSON.parse(first);
            verdict = d.status === 'success' ? `success/${d.availableUses}` : `${d.status}:${d.msg}`;
        } catch (e) {}
        console.log(`round ${i + 1}: ${verdict}`);
    });
})();
