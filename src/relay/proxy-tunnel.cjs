// Reaching the upstream through an HTTP proxy.
//
// The captcha ticket is signed for the address the page reached the server from, and the detection
// socket has to arrive from that same address. The page leaves through whatever proxy the system is
// configured with, so the relay has to leave through the same one; see resolveProxy() in config.cjs
// for how that proxy is found.
//
// A tunnel is an HTTP CONNECT handshake and then a byte pipe, which is why this is a promise rather
// than a socket.
const net = require('node:net');

const TUNNEL_TIMEOUT_MS = 8000;

function openTunnel(proxy, target, { timeoutMs = TUNNEL_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(proxy.port, proxy.host);
        let settled = false;
        let head = '';

        const fail = error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            reject(error);
        };

        const timer = setTimeout(() => {
            fail(new Error(`proxy ${proxy.host}:${proxy.port} did not answer CONNECT ${target} in time`));
        }, timeoutMs);

        // `on`, not `once`: a socket can report more than once, and a second report on a listener that
        // already fired has nobody to go to, which ends the process. Only the first one settles.
        socket.on('error', fail);

        socket.once('connect', () => {
            socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);

            const onData = chunk => {
                head += chunk.toString('latin1');
                const end = head.indexOf('\r\n\r\n');
                if (end === -1) return;

                socket.removeListener('data', onData);
                if (settled) return;

                const status = Number((head.match(/^HTTP\/1\.[01] (\d{3})/) || [])[1]);
                if (status !== 200) {
                    fail(new Error(`proxy ${proxy.host}:${proxy.port} refused CONNECT ${target} (${status || 'no status'})`));
                    return;
                }

                settled = true;
                clearTimeout(timer);

                // Nothing can follow the proxy's reply in this packet. The caller speaks TLS, and TLS
                // is client-first: the target has received nothing yet, so it has nothing to send. The
                // reply is therefore the whole of this chunk, and no leftover bytes need handing over.
                //
                // `fail` stays attached on purpose: it no-ops once settled, so a late error on the
                // socket has somewhere to go instead of ending the process.
                resolve(socket);
            };

            socket.on('data', onData);
        });
    });
}

module.exports = { openTunnel, TUNNEL_TIMEOUT_MS };
