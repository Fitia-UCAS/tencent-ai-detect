// Does Chromium actually fragment a WebSocket message, and at what size?
//
// The relay rejects fragmented frames (FIN=0 or a continuation opcode) by closing the
// socket. Whether that can ever happen depends entirely on the client: if Chromium always
// sends one frame per send(), the gap is unreachable in this project and is a robustness
// note; if it fragments above some size, a long pasted text would kill the detection
// socket and that is a live defect.
//
// This measures it directly: a local raw WebSocket server records the FIN bit and opcode of
// every frame it receives, a local page sends payloads of increasing size, and the result is
// the smallest size at which more than one frame appears.
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');

const { sleep, cdp, launch } = require('./browser-harness.cjs');

const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SIZES = (process.env.SIZES || "1024,65536,131071,131072,131073,200000").split(",").map(Number);

// Records frames as they arrive, per connection.
const log = [];

function startPageServer() {
    return new Promise(resolve => {
        const page = [
            '<!doctype html><meta charset="utf-8"><title>ws probe</title>',
            '<script>',
            'window.results = [];',
            'window.probe = size => new Promise(resolve => {',
            '  const ws = new WebSocket("ws://127.0.0.1:" + location.port + "/ws");',
            '  ws.onopen = () => {',
            '    const payload = "A".repeat(size);',
            '    const started = performance.now();',
            '    ws.send(payload);',
            '    setTimeout(() => { ws.close(); resolve({ size, ms: Math.round(performance.now() - started) }); }, 400);',
            '  };',
            '  ws.onerror = () => resolve({ size, error: true });',
            '});',
            '</script>'
        ].join('\n');

        const server = http.createServer((req, res) => {
            if (req.url === '/ws') return; // handled by upgrade
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(page);
        });

        server.on('upgrade', (req, socket) => {
            const key = req.headers['sec-websocket-key'];
            const accept = crypto.createHash('sha1')
                .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
                .digest('base64');

            socket.write(
                'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n' +
                `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
            );

            const entry = { frames: [], total: 0, finished: false };
            log.push(entry);

            let buffer = Buffer.alloc(0);

            socket.on('data', chunk => {
                buffer = Buffer.concat([buffer, chunk]);

                while (buffer.length >= 2) {
                    const fin = (buffer[0] & 0x80) !== 0;
                    const opcode = buffer[0] & 0x0f;
                    const masked = (buffer[1] & 0x80) !== 0;
                    let length = buffer[1] & 0x7f;
                    let cursor = 2;

                    if (length === 126) {
                        if (buffer.length < 4) return;
                        length = buffer.readUInt16BE(2);
                        cursor = 4;
                    } else if (length === 127) {
                        if (buffer.length < 10) return;
                        length = Number(buffer.readBigUInt64BE(2));
                        cursor = 10;
                    }

                    if (masked) cursor += 4;
                    if (buffer.length < cursor + length) return;

                    entry.frames.push({ fin, opcode, length });
                    entry.total += length;
                    buffer = buffer.subarray(cursor + length);

                    if (opcode === 0x8) {
                        entry.finished = true;
                        // Answer the close so the page's onclose completes.
                        socket.end(Buffer.from([0x88, 0x00]));
                        return;
                    }
                }
            });

            socket.on('error', () => {});
        });

        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

(async () => {
    const { server, port } = await startPageServer();
    let session = null;

    try {
        session = await launch({
            browser: BROWSER,
            port: 9391,
            prefix: 'zqwsprobe',
            args: ['--no-first-run']
        });

        const targets = await (await fetch(`http://127.0.0.1:9391/json/list`)).json();
        const page = targets.find(t => t.type === 'page');
        const conn = await cdp(page.webSocketDebuggerUrl);

        await conn.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
        await sleep(1500);

        process.stdout.write('payload size → frames observed by the WebSocket server\n\n');

        for (const size of SIZES) {
            const index = log.length;
            await conn.send('Runtime.evaluate', {
                expression: `window.probe(${size})`,
                awaitPromise: true,
                returnByValue: true
            });
            await sleep(300);

            const entry = log[index];
            if (!entry) {
                process.stdout.write(`  ${(size / 1024).toFixed(0)} KiB: no connection\n`);
                continue;
            }

            const dataFrames = entry.frames.filter(f => f.opcode === 0x1 || f.opcode === 0x2 || f.opcode === 0x0);
            const fragmented = dataFrames.length > 1 || dataFrames.some(f => !f.fin);

            process.stdout.write(
                `  ${String((size / 1024).toFixed(0)).padStart(6)} KiB: ` +
                `${dataFrames.length} data frame(s)` +
                `${dataFrames.length ? ` [${dataFrames.map(f => (f.opcode === 0x0 ? 'cont' : 'text') + (f.fin ? '' : '/FIN=0')).join(', ')}]` : ''}` +
                ` ${fragmented ? '← FRAGMENTED' : ''}\n`
            );
        }

        const anyFragmented = log.some(entry => {
            const dataFrames = entry.frames.filter(f => f.opcode === 0x1 || f.opcode === 0x2 || f.opcode === 0x0);
            return dataFrames.length > 1 || dataFrames.some(f => !f.fin);
        });

        process.stdout.write(`\nverdict: ${anyFragmented
            ? 'Chromium does fragment; the relay would close the socket on this message'
            : 'Chromium sent every payload as a single frame; the relay gap is not reachable from a page send()'}\n`);

        conn.close();
    } finally {
        if (session) await session.cleanup();
        server.close();
    }
})().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
