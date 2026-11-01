// What close code does the page actually see through the relay?
//
// The offline test proves the relay answers a close handshake. This confirms the page's own
// view: through the shipped extension, a normal close should surface as 1000 rather than 1006,
// because shim.js forwards event.code to the page.
const path = require('node:path');

const { sleep, cdp, launch } = require('./browser-harness.cjs');

const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.resolve(__dirname, '..');
const SITE = 'https://matrix.tencent.com/ai-detect/';

(async () => {
    const session = await launch({
        browser: BROWSER,
        port: 9398,
        prefix: 'zqclose',
        args: [
            '--disable-features=DisableLoadExtensionCommandLineSwitch',
            `--disable-extensions-except=${EXT}`,
            `--load-extension=${EXT}`
        ]
    });

    try {
        const targets = await (await fetch('http://127.0.0.1:9398/json/list')).json();
        const tab = targets.find(t => t.type === 'page');
        const conn = await cdp(tab.webSocketDebuggerUrl);

        await conn.send('Page.navigate', { url: SITE });
        await sleep(16000);

        // The relay is started by the worker; the probe is meaningless before it answers.
        let up = false;
        for (let i = 0; i < 40 && !up; i++) {
            up = await fetch('http://127.0.0.1:9420/health')
                .then(r => r.text()).then(t => t.includes('zq-local-relay-v1')).catch(() => false);
            if (!up) await sleep(500);
        }
        process.stdout.write(`relay answering before the probe: ${up}\n`);

        const result = await conn.send('Runtime.evaluate', {
            expression: `(() => new Promise(resolve => {
                // Connect to the relay directly, with the real site's own Origin, so this
                // measures the browser <-> relay close handshake without shim.js in between.
                const ws = new WebSocket('ws://127.0.0.1:9420/ws');
                const outcome = { opened: false, code: null, wasClean: null, target: 'relay-direct' };
                ws.onopen = () => {
                    outcome.opened = true;
                    setTimeout(() => { try { ws.close(1000, 'done'); } catch (e) {} }, 600);
                };
                ws.onclose = event => {
                    outcome.code = event.code;
                    outcome.wasClean = event.wasClean;
                    resolve(outcome);
                };
                ws.onerror = () => {};
                setTimeout(() => resolve({ ...outcome, timeout: true }), 12000);
            }))()`,
            awaitPromise: true,
            returnByValue: true
        });

        const outcome = result.result?.value || {};
        process.stdout.write(`opened=${outcome.opened} closeCode=${outcome.code} wasClean=${outcome.wasClean}\n`);

        if (!outcome.opened) {
            process.stdout.write('verdict: the socket never opened; nothing can be concluded\n');
            process.exitCode = 1;
        } else if (outcome.code === 1000) {
            process.stdout.write('verdict: the page sees a normal close (1000), not an abnormal one\n');
        } else {
            process.stdout.write(`verdict: the page still sees ${outcome.code} instead of 1000\n`);
            process.exitCode = 1;
        }

        conn.close();
    } finally {
        await session.cleanup();
    }
})().catch(error => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
