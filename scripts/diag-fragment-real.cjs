// Does a >128 KiB send survive the relay in a real browser, end to end?
//
// The offline test proves reassembly on crafted frames. This exercises the same code through the
// shipped extension on the real site: the page creates the same socket the detector creates
// (the shim rewrites it to the local relay), sends more than Chromium's 128 KiB fragmentation
// threshold, and reports whether the socket stayed usable.
//
// Before the reassembler existed the relay closed the socket on the first fragment, so a closed
// socket here is a regression and an open one is the fix holding. The payload is deliberately
// invalid detection text: the point is the transport, not the answer, and the upstream reply is
// reported rather than asserted.
const path = require('node:path');

const { sleep, cdp, launch } = require('./browser-harness.cjs');

const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.resolve(__dirname, '..');
const SITE = 'https://matrix.tencent.com/ai-detect/';
const SIZE = Number(process.env.SIZE || 200000);

(async () => {
    const session = await launch({
        browser: BROWSER,
        port: 9397,
        prefix: 'zqreal',
        args: [
            '--disable-features=DisableLoadExtensionCommandLineSwitch',
            `--disable-extensions-except=${EXT}`,
            `--load-extension=${EXT}`
        ]
    });

    try {
        const targets = await (await fetch('http://127.0.0.1:9397/json/list')).json();
        const tab = targets.find(t => t.type === 'page');
        const conn = await cdp(tab.webSocketDebuggerUrl);

        await conn.send('Page.navigate', { url: SITE });

        // The page needs ~15s before its Vue app and the detection socket exist. The relay is
        // started by the extension's worker, so wait for it to answer as well: probing before it
        // is up measures the wrong thing.
        await sleep(16000);

        const health = () => fetch('http://127.0.0.1:9420/health')
            .then(r => r.text())
            .then(t => t.includes('zq-local-relay-v1'))
            .catch(() => false);

        let relayUp = false;
        for (let i = 0; i < 40 && !relayUp; i++) {
            relayUp = await health();
            if (!relayUp) await sleep(500);
        }
        process.stdout.write(`relay answering before the probe: ${relayUp}\n`);

        const probe = `(() => new Promise(resolve => {
            const outcome = { size: ${SIZE}, opened: false, sent: false, replies: [], closed: null };
            let ws;
            try {
                // Same URL shape the detector uses, so the shim rewrites it to the relay.
                ws = new WebSocket('wss://matrix.tencent.com/ai_gen_txt_server');
            } catch (e) {
                resolve({ ...outcome, constructError: String(e && e.message || e) });
                return;
            }
            ws.onopen = () => {
                outcome.opened = true;
                try {
                    ws.send('A'.repeat(${SIZE}));
                    outcome.sent = true;
                } catch (e) {
                    outcome.sendError = String(e && e.message || e);
                }
            };
            ws.onmessage = event => {
                const text = String(event.data).slice(0, 120);
                outcome.replies.push(text);
            };
            ws.onclose = event => { outcome.closed = event.code; };
            ws.onerror = () => { outcome.error = true; };
            setTimeout(() => {
                try { ws.close(); } catch (e) {}
                resolve(outcome);
            }, 6000);
        }))()`;

        const result = await conn.send('Runtime.evaluate', {
            expression: probe,
            awaitPromise: true,
            returnByValue: true,
            awaitPromise: true
        });

        const outcome = result.result?.value || {};
        process.stdout.write(`opened=${outcome.opened} sent=${outcome.sent} closed=${outcome.closed} ` +
            `error=${outcome.error || false} replies=${JSON.stringify(outcome.replies)}\n`);

        if (!outcome.opened || !outcome.sent) {
            process.stdout.write('verdict: the socket never became usable; nothing can be concluded\n');
            process.exitCode = 1;
        } else if (outcome.closed !== null && outcome.replies.length === 0) {
            process.stdout.write('verdict: the relay closed the socket on a large send (fragmentation not handled)\n');
            process.exitCode = 1;
        } else {
            process.stdout.write('verdict: the large send went through and the socket stayed usable\n');
        }

        conn.close();
    } finally {
        await session.cleanup();
    }
})().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
