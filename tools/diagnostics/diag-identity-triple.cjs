// Compares the address the page chose, the address the header rule carries, and the address the
// relay puts on the socket.
//
// "Invalid request" is the server refusing a captcha ticket that was issued for a different address
// than the socket presents. Any one of the three falling out of step produces it, and the message
// names none of them, so the three are read directly.
const path = require('node:path');
const fs = require('node:fs');
const { sleep, httpJson, cdp, launch } = require('../browser-harness.cjs');

const EXT = path.resolve(__dirname, '..', '..');
const PORT = 9485;
const SITE = 'https://matrix.tencent.com/ai-detect/';

const EDGE = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

(async () => {
    const env = await launch({
        browser: EDGE,
        port: PORT,
        prefix: 'zqcdp',
        args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
    });

    try {
        let worker = null;
        let workerConn = null;

        // The extension id, from the manifest key. Matching on the URL alone also catches Edge's own
        // built-in workers, and their permission sets look nothing like the extension's.
        const EXT_ID = 'kdjgfockdecdbadmpbjgflmiffdiffhp';

        for (let i = 0; i < 40 && !workerConn; i += 1) {
            const targets = await httpJson(PORT, '/json/list');
            const sw = (targets || []).find(t =>
                t.type === 'service_worker' && (t.url || '').includes(EXT_ID));
            if (sw) {
                worker = sw;
                workerConn = await cdp(sw.webSocketDebuggerUrl);
            } else {
                await sleep(300);
            }
        }
        if (!workerConn) throw new Error('no extension service worker');

        await workerConn.send('Runtime.enable');

        // Rules as the browser actually holds them, not as the code intends them.
        const rules = await workerConn.send('Runtime.evaluate', {
            expression: `chrome.declarativeNetRequest.getDynamicRules().then(r => JSON.stringify(r))`,
            awaitPromise: true,
            returnByValue: true
        });

        console.log('DYNAMIC RULES:', (rules.result && rules.result.value) || '(none)');

        await workerConn.send('Runtime.evaluate', {
            expression: `chrome.tabs.create({ url: ${JSON.stringify(SITE)}, active: true })`,
            awaitPromise: true
        });

        let page = null;
        for (let i = 0; i < 40 && !page; i += 1) {
            const targets = await httpJson(PORT, '/json/list');
            page = (targets || []).find(t => (t.url || '').includes('matrix.tencent.com'));
            if (!page) await sleep(300);
        }

        const pageConn = await cdp(page.webSocketDebuggerUrl);

        const contexts = [];
        pageConn.on(msg => {
            if (msg.method === 'Runtime.executionContextCreated') {
                const c = msg.params.context;
                if (c.name && c.name.includes('Tencent AI Detect')) contexts.push(c);
            }
        });

        await pageConn.send('Runtime.enable');
        await sleep(10000);

        // The address this load published, read from the content script's own world.
        const isolated = contexts[contexts.length - 1];
        if (isolated) {
            const chosen = await pageConn.send('Runtime.evaluate', {
                contextId: isolated.id,
                expression: `JSON.stringify({
                    chosen: localStorage.getItem('zqXff'),
                    uses: localStorage.getItem('zqXffUses')
                })`,
                returnByValue: true
            });
            console.log('PAGE CHOSE:', (chosen.result && chosen.result.value) || '(none)');
        } else {
            console.log('PAGE CHOSE: (no isolated world)');
        }

        // Rules again, after the load published its address.
        const rulesAfter = await workerConn.send('Runtime.evaluate', {
            expression: `chrome.declarativeNetRequest.getDynamicRules().then(r => JSON.stringify(r))`,
            awaitPromise: true,
            returnByValue: true
        });
        console.log('RULES AFTER LOAD:', (rulesAfter.result && rulesAfter.result.value) || '(none)');

        pageConn.close();
        workerConn.close();
    } finally {
        await env.cleanup();
    }
})().catch(error => {
    process.stderr.write(`probe failed: ${error.message}\n`);
    process.exitCode = 1;
});
