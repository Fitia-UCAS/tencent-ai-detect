// Probes the upstream detection endpoint directly, without the relay, several
// times in a row.
//
// Purpose: tell a persistent block apart from a transient one. The relay's own
// address pool is accepted consistently; if direct connections are refused every
// time, this machine's real egress address is being refused at the very first
// frame, and no amount of fingerprint rotation will change that.
const tls = require('node:tls');
const crypto = require('node:crypto');

const HOST = 'matrix.tencent.com';
const PATHNAME = '/ai_gen_txt_server/getClassify';
const ROUNDS = Number(process.argv[2] || 4);
// An explicit fp can be passed to compare "a value this endpoint accepted
// before" against "whatever the page generated just now".
const FP = process.argv[3] || 'a5515fd229f8ecfa446b3239d19e00e0';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function probe(extraHeaders = '') {
    return new Promise(resolve => {
        const key = crypto.randomBytes(16).toString('base64');
        let settled = false;
        let buffer = Buffer.alloc(0);
        let upgraded = false;

        const done = result => {
            if (settled) return;
            settled = true;
            try { socket.destroy(); } catch (e) { }
            resolve(result);
        };

        const socket = tls.connect({ host: HOST, port: 443, servername: HOST }, () => {
            socket.write(
                `GET ${PATHNAME} HTTP/1.1\r\n` +
                `Host: ${HOST}\r\n` +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                `Sec-WebSocket-Key: ${key}\r\n` +
                'Sec-WebSocket-Version: 13\r\n' +
                `Origin: https://${HOST}\r\n` +
                'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36\r\n' +
                extraHeaders +
                '\r\n'
            );
        });

        socket.setTimeout(10000, () => done({ ok: false, reason: 'timeout' }));
        socket.on('error', error => done({ ok: false, reason: error.message }));

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

                const payload = Buffer.from(JSON.stringify({ fp: FP }));
                const mask = crypto.randomBytes(4);
                const masked = Buffer.from(payload);

                for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];

                const len = masked.length;
                const header = len < 126
                    ? Buffer.from([0x81, 0x80 | len])
                    : Buffer.from([0x81, 0x80 | 126, (len >> 8) & 0xff, len & 0xff]);

                socket.write(Buffer.concat([header, mask, masked]));
                return;
            }

            // Server frames are unmasked and small here.
            if (buffer.length < 2) return;

            let len = buffer[1] & 0x7f;
            let offset = 2;

            if (len === 126) {
                if (buffer.length < 4) return;
                len = buffer.readUInt16BE(2);
                offset = 4;
            }

            if (buffer.length < offset + len) return;

            done({ ok: true, body: buffer.subarray(offset, offset + len).toString('utf8') });
        });
    });
}

(async () => {
    let accepted = 0;

    for (let i = 0; i < ROUNDS; i++) {
        const result = await probe();

        if (!result.ok) {
            process.stdout.write(`  ${i + 1}  ERROR   ${result.reason}\n`);
        } else if (/"status"\s*:\s*"success"/.test(result.body)) {
            accepted += 1;
            process.stdout.write(`  ${i + 1}  ACCEPT  ${result.body}\n`);
        } else {
            process.stdout.write(`  ${i + 1}  REFUSE  ${result.body}\n`);
        }

        await sleep(1200);
    }

    process.stdout.write(`\ndirect connections accepted ${accepted}/${ROUNDS}\n`);

    if (accepted === 0) {
        process.stdout.write('the real egress address is refused every time; the relay pool still works, so only the address differs\n');
    } else {
        process.stdout.write('the real egress address is sometimes accepted, so the earlier refusal was transient\n');
    }
})();
