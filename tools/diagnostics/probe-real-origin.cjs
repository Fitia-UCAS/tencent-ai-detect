// Captures the exact WebSocket handshake the real page sends to the relay.
//
// The v1.5.4 design adds a strict Origin whitelist, which only works if the real
// browser sends exactly that value. Guessing here would break the extension, so
// this records what actually arrives instead.
//
// Only local data is recorded. Nothing is sent to any third party by this file;
// the relay it observes is the project's own loopback process.
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.resolve(__dirname, '..', '..');
const PORT = 9387;
const RELAY_PORT = 9420;

const { sleep, httpJson, cdp, launch } = require('../browser-harness.cjs');

// A stand-in relay that records the handshake headers, then answers the page with
// a benign failure so the site's own reconnect logic stays predictable.
function startRecordingRelay() {
    const seen = [];
    const sockets = new Set();

    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('error', () => sockets.delete(socket));
        socket.on('close', () => sockets.delete(socket));

        let raw = '';

        socket.on('data', chunk => {
            raw += chunk.toString('utf8');

            const end = raw.indexOf('\r\n\r\n');
            if (end === -1) return;

            const head = raw.slice(0, end);
            const lines = head.split('\r\n');
            const requestLine = lines[0] || '';
            const headers = {};

            lines.slice(1).forEach(line => {
                const idx = line.indexOf(':');
                if (idx === -1) return;
                headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
            });

            seen.push({
                requestLine,
                method: requestLine.split(' ')[0],
                path: requestLine.split(' ')[1],
                origin: headers.origin === undefined ? '(absent)' : headers.origin,
                host: headers.host,
                hasKey: !!headers['sec-websocket-key'],
                version: headers['sec-websocket-version'],
                upgrade: headers.upgrade
            });

            // Refuse politely: the observation is complete at this point.
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            socket.end();
        });
    });

    return new Promise(resolve => {
        server.listen(RELAY_PORT, '127.0.0.1', () => {
            resolve({
                seen,
                stop: () => new Promise(done => {
                    for (const s of sockets) {
                        try { s.destroy(); } catch (e) {}
                    }
                    server.close(() => done());
                })
            });
        });
    });
}

(async () => {
    let relay = null;
    let session = null;

    try {
        relay = await startRecordingRelay();

        session = await launch({
            browser: BROWSER,
            port: PORT,
            prefix: 'zqorigin',
            args: [
                '--disable-features=DisableLoadExtensionCommandLineSwitch',
                `--disable-extensions-except=${EXT}`,
                `--load-extension=${EXT}`
            ]
        });

        const target = await httpJson(PORT, '/json/new?about:blank', 'PUT');
        const page = await cdp(target.webSocketDebuggerUrl);

        await page.send('Page.enable');
        await page.send('Page.navigate', { url: 'https://matrix.tencent.com/ai-detect/' });

        // The page opens its socket on load; give it room to connect and retry.
        await sleep(12000);

        page.close();
    } finally {
        if (session) await session.cleanup();
        if (relay) await relay.stop();
    }

    const unique = [];
    const seenKeys = new Set();

    for (const item of relay.seen) {
        const key = JSON.stringify(item);
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        unique.push(item);
    }

    process.stdout.write(JSON.stringify({
        handshakesObserved: relay.seen.length,
        uniqueShapes: unique
    }, null, 2) + '\n');
})();
