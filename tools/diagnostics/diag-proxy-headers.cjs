// Does the proxy touch the address header on its way through?
//
// The detection is refused when the ticket was issued for one address and the socket claims another.
// The socket's claim is written here, so it is known; the ticket's is whatever the captcha service saw
// on the request that issued it. TLS protects those headers from a proxy, but a plain-HTTP request has
// no such protection: a forwarding proxy may append the client's own address to X-Forwarded-For, and a
// server that reads the last entry then binds the ticket to the real address while the socket claims
// the synthetic one.
//
// This asks the proxy directly. A local echo server stands in for the far side, so what arrives is
// what a remote server would have seen, and no third party is involved.
const http = require('node:http');
const net = require('node:net');

const { resolveProxy, describeProxy } = require('../../src/relay/config.cjs');

const CLAIM = '112.90.44.17';
const PORT = Number(process.env.ECHO_PORT || 18080);

// One request through the proxy, one straight to the echo server, and the header each delivered.
function viaProxy(header) {
    return new Promise((resolve, reject) => {
        const proxy = resolveProxy();
        if (!proxy) {
            resolve(null);
            return;
        }

        const socket = net.connect(proxy.port, proxy.host, () => {
            socket.write(
                `GET http://127.0.0.1:${PORT}/echo HTTP/1.1\r\n` +
                `Host: 127.0.0.1:${PORT}\r\n` +
                `X-Forwarded-For: ${header}\r\n` +
                'X-Diag-Via: through-proxy\r\n' +
                'Connection: close\r\n\r\n');
        });

        socket.setTimeout(8000, () => {
            socket.destroy();
            reject(new Error('proxy did not answer in time'));
        });
        socket.on('error', reject);
        socket.on('data', () => {});
        socket.on('close', () => resolve(true));
    });
}

function direct(header) {
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: '127.0.0.1',
            port: PORT,
            path: '/echo',
            headers: {
                'X-Forwarded-For': header,
                'X-Diag-Via': 'direct'
            }
        }, response => {
            response.resume();
            response.on('end', resolve);
        });

        request.on('error', reject);
        request.end();
    });
}

(async () => {
    const seen = [];

    const server = http.createServer((req, res) => {
        seen.push({
            via: req.headers['x-diag-via'] || 'unknown',
            forwarded: req.headers['x-forwarded-for'] === undefined
                ? '(absent)'
                : String(req.headers['x-forwarded-for'])
        });
        res.writeHead(200, { 'Content-Type': 'text/plain', Connection: 'close' });
        res.end('ok');
    });

    await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve));

    process.stdout.write(`proxy: ${describeProxy(resolveProxy())}\n`);
    process.stdout.write(`header written: X-Forwarded-For: ${CLAIM}\n\n`);

    try {
        await direct(CLAIM);
        await new Promise(resolve => setTimeout(resolve, 150));

        const throughProxy = resolveProxy();
        if (throughProxy) {
            await viaProxy(CLAIM);
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        for (const entry of seen) {
            const same = entry.forwarded === CLAIM;
            process.stdout.write(`  ${entry.via.padEnd(8)} delivered: ${entry.forwarded}` +
                `   ${same ? '(unchanged)' : '(CHANGED by the proxy)'}\n`);
        }

        if (!throughProxy) {
            process.stdout.write('  no proxy configured, so there is nothing to compare\n');
        }
    } finally {
        server.close();
        // A socket the proxy left half-open would keep the process alive for no reason.
        setTimeout(() => process.exit(0), 200).unref();
    }
})();
