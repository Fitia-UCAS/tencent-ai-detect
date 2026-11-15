// Measures what the page does once the address count reaches the limit.
//
// Two behaviours are distinguished, and only one of them is wanted:
//
//   * rotating on its own  - a reload, which destroys the result of the last usable detection. This
//                            is what happened before: measured at about 1.5s after the count reached
//                            the limit, so that result was never read.
//   * reporting and waiting - the page keeps its result, and the rotation happens on the next press
//                            because that press is the one the spent address cannot serve.
//
// This sets the count directly instead of spending real detections, so nothing is consumed on the
// site's quota, and watches for a navigation for longer than several watchdog ticks.
const path = require('node:path');
const fs = require('node:fs');
const { sleep, httpJson, cdp, launch } = require('../browser-harness.cjs');

const EXT = path.resolve(__dirname, '..', '..');
const PORT = 9488;
const SITE = 'https://matrix.tencent.com/ai-detect/';
const EXT_ID = 'kdjgfockdecdbadmpbjgflmiffdiffhp';

// Longer than the 2s watchdog interval, several times over.
const WATCH_MS = 7000;

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
        for (let i = 0; i < 60 && !target; i += 1) {
            const targets = await httpJson(PORT, '/json/list');
            target = (targets || []).find(t => t.type === 'page' && (t.url || '').includes('matrix.tencent.com'));
            if (!target) {
                if (i > 0 && i % 20 === 0) {
                    console.log('still looking; targets so far:',
                        (targets || []).map(t => t.type + ' ' + String(t.url).slice(0, 60)).join(' | '));
                }
                await sleep(300);
            }
        }
        if (!target) {
            const targets = await httpJson(PORT, '/json/list');
            console.log('targets:', JSON.stringify((targets || []).map(t => ({ type: t.type, url: t.url })), null, 1));
            throw new Error('no page target');
        }

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

        // Watch across several watchdog ticks.
        while (Date.now() - startedAt < WATCH_MS) {
            await sleep(250);
            if (navigations > before) break;
        }

        const elapsed = Date.now() - startedAt;
        const reloaded = navigations > before;

        console.log('watched      :', elapsed + 'ms (watchdog ticks: 2s each)');
        console.log('reloaded     :', reloaded ? 'YES after ~' + elapsed + 'ms' : 'no');

        const marker = await conn.send('Runtime.evaluate', {
            expression: `!!document.getElementById('zq-result-marker')`,
            returnByValue: true
        });
        console.log('result kept  :', marker.result && marker.result.value ? 'YES, still on the page' : 'NO, it is gone');

        if (reloaded) {
            console.log('\nFAIL: the page rotated on its own, so the last usable result was destroyed.');
            console.log('The rotation must wait for the next press instead.');
            process.exitCode = 1;
        } else {
            console.log('\nPASS: a spent address no longer reloads the page by itself.');
            console.log('The result stays visible; the next press is what rotates.');
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
