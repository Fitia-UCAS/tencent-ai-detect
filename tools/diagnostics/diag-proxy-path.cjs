// Does the detection socket survive the proxy, and does the server accept the same claimed address
// on both paths?
//
// Run this when a proxy client is on and the page says "Invalid request". It answers three questions
// that the page's wording cannot separate:
//
//   * the outbound path the relay would take, resolved the same way the relay resolves it;
//   * whether a handshake over that path reaches the server at all, and how long it takes;
//   * whether the server accepts the connection - the reply to the first frame is the server's
//     answer, so a refusal here is the server refusing, not the page failing to ask.
//
// The claimed address is a parameter, not a guess: the ticket the page sends is bound to the address
// its captcha request carried, so a probe that claims a different one is testing a different
// question. Pass the address the page published (data-zq-xff) to reproduce its situation.
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const { resolveProxy, describeProxy } = require('../../src/relay/config.cjs');
const { openTunnel } = require('../../src/relay/proxy-tunnel.cjs');

const HOST = 'matrix.tencent.com';
const PATH = '/ai_gen_txt_server/getClassify';
const TIMEOUT_MS = 12000;

const ADDRESS = process.argv[2] || '112.90.44.17';
const ROUNDS = Number(process.argv[3] || 2);

const PROXY = resolveProxy();

const elapsed = (from, to) => String(to - from).padStart(5) + 'ms';

// One handshake, one first frame. Resolves with what happened rather than throwing: every outcome
// here is a measurement.
function probe(path) {
    return new Promise(resolve => {
        const started = Date.now();
        let settled = false;
        let upgraded = false;
        let buffer = Buffer.alloc(0);

        const done = result => {
            if (settled) return;
            settled = true;
            resolve({ path, ms: Date.now() - started, ...result });
        };

        const dial = path === 'direct'
            ? new Promise((ok, fail) => {
                const socket = net.connect(443, HOST);
                socket.once('connect', () => ok(socket));
                socket.on('error', fail);
            })
            : openTunnel(PROXY, `${HOST}:443`);

        dial.then(socket => {
            socket.setTimeout(TIMEOUT_MS, () => {
                done({ ok: false, reason: 'timeout' });
                socket.destroy();
            });

            const secure = tls.connect({ socket, servername: HOST }, () => {
                const key = crypto.randomBytes(16).toString('base64');

                secure.write(
                    `GET ${PATH} HTTP/1.1\r\n` +
                    `Host: ${HOST}\r\n` +
                    'Upgrade: websocket\r\n' +
                    'Connection: Upgrade\r\n' +
                    `Sec-WebSocket-Key: ${key}\r\n` +
                    'Sec-WebSocket-Version: 13\r\n' +
                    `Origin: https://${HOST}\r\n` +
                    // Relayed through, not swallowed: a proxy that rewrites this header is exactly
                    // what this probe is looking for.
                    `X-Forwarded-For: ${ADDRESS}\r\n` +
                    'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                    '(KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36\r\n\r\n'
                );

                const payload = Buffer.from(JSON.stringify({ fp: 'a5515fd229f8ecfa446b3239d19e00e0' }));
                const header = Buffer.from([0x81, 0x80 | payload.length]);
                const mask = crypto.randomBytes(4);
                const masked = Buffer.from(payload);
                for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];

                secure.write(Buffer.concat([header, mask, masked]));
            });

            secure.on('error', error => done({ ok: false, reason: error.message }));

            secure.on('data', chunk => {
                buffer = Buffer.concat([buffer, chunk]);

                if (!upgraded) {
                    const head = buffer.toString('latin1');
                    const end = head.indexOf('\r\n\r\n');
                    if (end === -1) return;

                    if (!/^HTTP\/1\.[01] 101/.test(head)) {
                        done({ ok: false, reason: head.split('\r\n')[0] });
                        secure.destroy();
                        return;
                    }

                    upgraded = true;
                    buffer = buffer.subarray(end + 4);
                }

                if (buffer.length < 2) return;

                let length = buffer[1] & 0x7f;
                let offset = 2;

                if (length === 126) {
                    if (buffer.length < 4) return;
                    length = buffer.readUInt16BE(2);
                    offset = 4;
                }

                if (buffer.length < offset + length) return;

                done({ ok: true, body: buffer.subarray(offset, offset + length).toString('utf8') });
                secure.destroy();
            });
        }, error => done({ ok: false, reason: error.message }));
    });
}

(async () => {
    process.stdout.write(`proxy from the system: ${describeProxy(PROXY)}\n`);
    process.stdout.write(`claimed address:     ${ADDRESS}\n\n`);

    const paths = PROXY ? ['direct', 'proxy'] : ['direct'];

    for (const path of paths) {
        for (let round = 1; round <= ROUNDS; round += 1) {
            const result = await probe(path);

            if (!result.ok) {
                process.stdout.write(
                    `  ${path.padEnd(7)} ${round}  unreachable  ${result.reason}  (${result.ms}ms)\n`);
                continue;
            }

            const accepted = /"status"\s*:\s*"success"/.test(result.body);
            process.stdout.write(
                `  ${path.padEnd(7)} ${round}  ${accepted ? 'ACCEPTED' : 'REFUSED '}  ` +
                `${result.body}  (${elapsed(0, result.ms)})\n`);
        }
    }

    process.stdout.write('\n');
    process.stdout.write('REFUSED on both paths means the claimed address is the problem, not the proxy.\n');
    process.stdout.write('ACCEPTED direct but unreachable through the proxy means the proxy path is the problem.\n');
    process.stdout.write('ACCEPTED on both means this host would work either way, and the refusal came from\n');
    process.stdout.write('the ticket rather than from the socket: check the address each captcha request carried.\n');
})();
