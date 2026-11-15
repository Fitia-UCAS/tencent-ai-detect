// Measures when the page reloads itself once the address count reaches the limit.
//
// The claim under test: the watchdog reads the count every two seconds and rotates as soon as it is
// exhausted, so the result of the last usable detection is on screen for about two seconds and is
// then thrown away by the reload. This sets the count directly instead of spending real detections,
// so nothing is consumed on the site's quota, and watches for a navigation.
const path = require('node:path');
const fs = require('node:fs');
const { sleep, httpJson, cdp, launch } = require('../browser-harness.cjs');

const EXT = path.resolve(__dirname, '..', '..');
const PORT = 9488;
const SITE = 'https://matrix.tencent.com/ai-detect/';
const EXT_ID = 'kdjgfockdecdbadmpbjgflmiffdiffhp';

const EDGE = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

async function findWorker() {
    for (let i = 0; i < 40; i += 1) {
        const targets = await httpJson(PORT, '/json/list');
        const sw = (targets || []).find(t =>
            t.type === 'service_worker' && (t.url || '').includes(EXT_ID));
        if (sw) return sw;
        await sleep(300);
    }
    return null;
}

(async () => {
    if (!EDGE) {
        console.log('Edge not found.');
        return;
    }

    const session = await launch({
        browser: EDGE,
        port: PORT,
        prefix: 'zqexhaust',
        args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
    });

    try {
        const worker = await findWorker();
        if (!worker) throw new Error('no service worker');
        const workerConn = await cdp(worker.webSocketDebuggerUrl);
        await workerConn.send('Runtime.enable');

        const created = await workerConn.send('Runtime.evaluate', {
            expression: `chrome.tabs.create({ url: ${JSON.stringify(SITE)}, active: false }).then(t => t.id)`,
            awaitPromise: true,
            returnByValue: true
        });
        const tabId = created.result && created.result.value;

        let target = null;
        for (let i = 0; i < 40 && !target; i += 1) {
            const targets = await httpJson(PORT, '/json/list');
            target = (targets || []).find(t => t.type === 'page' && (t.url || '').includes('matrix.tencent.com'));
            if (!target) await sleep(300);
        }
        if (!target) throw new Error('no page target');

        const conn = await cdp(target.webSocketDebuggerUrl);
        const contexts = [];
        let navigations = 0;

        conn.on(msg => {
            if (msg.method === 'Runtime.executionContextCreated') {
                const context = msg.params.context;
                if (context.name && context.name.includes('Tencent AI Detect')) contexts.push(context);
            }
            if (msg.method === 'Page.frameNavigated' && msg.params.frame && !msg.params.frame.parentId) {
                navigations += 1;
            }
        });

        await conn.send('Runtime.enable');
        await conn.send('Page.enable');
        await sleep(9000);

        const isolated = contexts[contexts.length - 1];
        if (!isolated) throw new Error('no isolated world');

        console.log('tab id      :', tabId);
        console.log('navigations :', navigations);

        // A visible marker in the page, standing in for a detection result. If the page reloads, it
        // is gone: that is the same thing the user loses.
        await conn.send('Runtime.evaluate', {
            contextId: isolated.id,
            expression: `(() => {
                const root = document.documentElement;
                root.setAttribute('data-zq-xff-uses', '4');
                sessionStorage.setItem('zqXffUses', '4');
                const marker = document.createElement('div');
                marker.id = 'zq-result-marker';
                marker.textContent = 'RESULT OF THE LAST USABLE DETECTION';
                document.body.appendChild(marker);
                return 'set';
            })()`,
            returnByValue: true
        });

        const before = navigations;
        const startedAt = Date.now();

        // Look for the reload over a window comfortably longer than one watchdog tick.
        for (let i = 0; i < 16; i += 1) {
            await sleep(250);
            if (navigations > before) break;
        }

        const elapsed = Date.now() - startedAt;
        console.log('reloaded     :', navigations > before ? 'YES after ~' + elapsed + 'ms' : 'no (16 ticks observed)');

        if (navigations > before) {
            // Prove the marker - the stand-in for the result - was taken with it.
            const gone = await conn.send('Runtime.evaluate', {
                expression: `!document.getElementById('zq-result-marker')`,
                returnByValue: true
            });
            console.log('result lost  :', gone.result && gone.result.value ? 'YES, the marker is gone' : 'no, marker survived');
            console.log('\nCONFIRMED: the count reaching the limit reloads the page on its own,');
            console.log('so the last usable result is destroyed about ' + elapsed + 'ms after it lands.');
        } else {
            console.log('\nNOT CONFIRMED: the count reaching the limit did not reload the page in this run.');
        }

        conn.close();
        workerConn.close();
    } finally {
        await session.cleanup();
    }
})().catch(error => {
    process.stdout.write('probe failed: ' + (error && error.message ? error.message : error) + '\n');
    process.exitCode = 1;
});
