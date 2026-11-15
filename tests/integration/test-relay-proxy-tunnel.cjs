// The CONNECT tunnel the relay uses when a proxy is configured.
//
// Why this exists at all: the captcha ticket is signed for the address the page reached the server
// from, and the detection socket has to arrive from that same address. The page follows the system
// proxy; a bare net.connect() never does. With a proxy on those are two different addresses, and the
// server answers "Invalid request" every time. So the relay dials the tunnel instead, and this is
// the offline proof that it speaks the protocol - no TLS, no upstream, no network.
const assert = require('node:assert/strict');
const net = require('node:net');
const { openTunnel } = require('../../src/relay/proxy-tunnel.cjs');

const checks = [];
async function check(name, fn) {
    try {
        await fn();
        checks.push(true);
        console.log('  ok    ' + name);
    } catch (error) {
        checks.push(false);
        console.log('  FAIL  ' + name + ' — ' + error.message);
    }
}

// A proxy that answers CONNECT with `status` and then echoes whatever arrives.
//
// `refuse` answers with 407 instead of 200; `silent` accepts the connection and never answers.
function startProxy({ status = 200, refuse = false, silent = false } = {}) {
    return new Promise(resolve => {
        const seen = [];
        const server = net.createServer(socket => {
            let buffer = Buffer.alloc(0);
            socket.on('error', () => {});

            const onData = chunk => {
                buffer = Buffer.concat([buffer, chunk]);

                const end = buffer.indexOf('\r\n\r\n');
                if (end === -1) return;

                socket.removeListener('data', onData);
                seen.push(buffer.slice(0, end).toString('latin1'));
                if (silent) return;

                if (refuse) {
                    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
                    return;
                }

                socket.write(`HTTP/1.1 ${status} Connection Established\r\n\r\n`);
                const rest = buffer.slice(end + 4);
                if (rest.length) socket.write(rest);
                socket.on('data', data => socket.write(data));
            };

            socket.on('data', onData);
        });

        server.listen(0, '127.0.0.1', () => {
            resolve({
                proxy: { host: '127.0.0.1', port: server.address().port },
                seen,
                close: () => new Promise(done => server.close(done))
            });
        });
    });
}

const readOnce = socket => new Promise(resolve => socket.once('data', resolve));

(async () => {
    await check('the tunnel asks for the right host and port, and carries bytes once up', async () => {
        const fake = await startProxy();
        try {
            const socket = await openTunnel(fake.proxy, 'example.test:443');
            assert.match(fake.seen[0], /^CONNECT example\.test:443 HTTP\/1\.1/);
            assert.match(fake.seen[0], /Host: example\.test:443/);

            const received = readOnce(socket);
            socket.write('ping');
            assert.equal(String(await received), 'ping');
            socket.destroy();
        } finally {
            await fake.close();
        }
    });

    await check('a refused tunnel reports the proxy status', async () => {
        const fake = await startProxy({ refuse: true });
        try {
            await assert.rejects(
                openTunnel(fake.proxy, 'example.test:443'),
                /refused CONNECT example\.test:443 \(407\)/
            );
        } finally {
            await fake.close();
        }
    });

    await check('an unreachable proxy rejects instead of hanging', async () => {
        await assert.rejects(openTunnel({ host: '127.0.0.1', port: 1 }, 'example.test:443'));
    });

    await check('a silent proxy times out instead of hanging', async () => {
        const fake = await startProxy({ silent: true });
        try {
            const started = Date.now();
            await assert.rejects(
                openTunnel(fake.proxy, 'example.test:443', { timeoutMs: 120 }),
                /did not answer CONNECT/
            );
            assert.ok(Date.now() - started < 2000, 'the timeout was honoured');
        } finally {
            await fake.close();
        }
    });

    const failed = checks.filter(ok => !ok).length;
    console.log('');
    if (failed) {
        console.error(`${failed}/${checks.length} proxy tunnel checks failed`);
        process.exit(1);
    }
    console.log(`PASS: ${checks.length}/${checks.length} proxy tunnel checks`);
})();
