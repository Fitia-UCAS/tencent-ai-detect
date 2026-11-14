// Verifies the assumption the transport recovery rests on: an event dispatched from the page's own
// world reaches the isolated world's listener.
//
// The shim runs in the MAIN world (it has to, to wrap the page's WebSocket), and the recovery lives
// in the content script's isolated world. They share the DOM, but they are separate JS worlds, and
// events crossing that boundary have rules - a CustomEvent carrying an object in `detail` throws
// "Permission denied to access property" on the other side. This probe checks the parts that
// matter: that the listener fires at all, and that it fires for a detail-free event.
//
// The observable proof is a statusUpdate the content script writes to storage when it hears the
// event, so nothing has to be attached to the content script's own context.
const path = require('node:path');
const fs = require('node:fs');
const { sleep, httpJson, cdp, launch } = require('../browser-harness.cjs');

const EXT = path.resolve(__dirname, '..', '..');
const PORT = 9492;
const SITE = 'https://matrix.tencent.com/ai-detect/';
const EXT_ID = 'kdjgfockdecdbadmpbjgflmiffdiffhp';

const EDGE = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

const results = [];
const ok = message => { results.push([true, message]); console.log('  ok    ' + message); };
const fail = message => { results.push([false, message]); console.log('  FAIL  ' + message); };

(async () => {
    const env = await launch({
        browser: EDGE,
        port: PORT,
        prefix: 'zqcrossworld',
        args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
    });

    try {
        let worker = null;
        for (let i = 0; i < 40 && !worker; i += 1) {
            const targets = await httpJson(PORT, '/json/list');
            const sw = (targets || []).find(t => t.type === 'service_worker' && (t.url || '').includes(EXT_ID));
            if (sw) worker = await cdp(sw.webSocketDebuggerUrl);
            else await sleep(300);
        }
        if (!worker) { fail('the extension worker never started'); return; }
        ok('extension worker is up');

        await worker.send('Runtime.evaluate', {
            expression: `chrome.tabs.create({ url: ${JSON.stringify(SITE)}, active: true })`,
            awaitPromise: true
        });

        let page = null;
        for (let i = 0; i < 40 && !page; i += 1) {
            const targets = await httpJson(PORT, '/json/list');
            page = (targets || []).find(t => (t.url || '').includes('matrix.tencent.com'));
            if (!page) await sleep(300);
        }
        if (!page) { fail('the page never opened'); return; }

        const pageConn = await cdp(page.webSocketDebuggerUrl);
        await pageConn.send('Runtime.enable');
        await sleep(3500);

        // Note: `window.__zqDetectReady` is set in the isolated world, so evaluating it from the
        // page's world always reads undefined. That is exactly why the two worlds cannot coordinate
        // through shared globals, and why this probe observes storage instead.
        const isolated = await pageConn.send('Runtime.evaluate', {
            expression: 'window.__zqDetectReady === true',
            returnByValue: true
        });
        if (isolated.result && isolated.result.value === true) {
            fail('the page world can see the isolated world flag, which would be unexpected');
        } else {
            ok('the page world cannot read the isolated world flag (expected: separate worlds)');
        }

        // Clear the last status so a stale value cannot be mistaken for a fresh one.
        await worker.send('Runtime.evaluate', {
            expression: `chrome.storage.local.remove('lastStatus')`,
            awaitPromise: true
        });

        // Dispatch from the page's world, exactly as the shim does.
        await pageConn.send('Runtime.evaluate', {
            expression: `window.dispatchEvent(new CustomEvent('zq:relay-failed'))`,
            returnByValue: true
        });
        ok('event dispatched from the main world');

        // The recovery writes a status the moment it hears the event, whatever it decides after.
        let status = null;
        for (let i = 0; i < 20 && !status; i += 1) {
            await sleep(300);
            const stored = await worker.send('Runtime.evaluate', {
                expression: `chrome.storage.local.get('lastStatus').then(r => JSON.stringify(r.lastStatus || null))`,
                awaitPromise: true,
                returnByValue: true
            });
            const raw = stored.result && stored.result.value;
            if (raw && raw !== 'null') status = JSON.parse(raw);
        }

        if (status) {
            ok('the isolated world heard it (status: ' + status.status + ')');
            if (status.status === 'transport-failed' || status.status === 'relay-offline') {
                ok('and routed it through the recovery path');
            } else {
                fail('heard the event but reported an unexpected status: ' + status.status);
            }
        } else {
            fail('the isolated world never reacted; the event does not cross worlds');
        }

        // An event carrying an object in detail is the case that throws across worlds. If the shim
        // ever adds one, this is where it would break.
        await worker.send('Runtime.evaluate', {
            expression: `chrome.storage.local.remove('lastStatus')`,
            awaitPromise: true
        });

        await pageConn.send('Runtime.evaluate', {
            expression: `window.dispatchEvent(new CustomEvent('zq:relay-failed', { detail: { reason: 'probe' } }))`,
            returnByValue: true
        });

        let withDetail = null;
        for (let i = 0; i < 10 && !withDetail; i += 1) {
            await sleep(300);
            const stored = await worker.send('Runtime.evaluate', {
                expression: `chrome.storage.local.get('lastStatus').then(r => JSON.stringify(r.lastStatus || null))`,
                awaitPromise: true,
                returnByValue: true
            });
            const raw = stored.result && stored.result.value;
            if (raw && raw !== 'null') withDetail = JSON.parse(raw);
        }

        if (withDetail) ok('a detail payload does not break delivery');
        else fail('delivery broke when detail was present; the shim must keep the event payload-free');

        pageConn.close();
        worker.close();
    } finally {
        await env.cleanup();
    }
})().then(() => {
    const failures = results.filter(([passed]) => !passed);
    console.log(`\n${failures.length ? 'FAIL' : 'PASS'}: ${results.length - failures.length}/${results.length} cross-world checks`);
    if (failures.length) process.exitCode = 1;
}).catch(error => {
    process.stderr.write(`probe failed: ${error.message}\n`);
    process.exitCode = 1;
});
