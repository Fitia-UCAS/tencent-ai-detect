// Lists every target the debugging port exposes, so the extension's own worker can be told apart
// from Edge's built-in ones.
const path = require('node:path');
const fs = require('node:fs');
const { sleep, httpJson, cdp, launch } = require('../browser-harness.cjs');

const EXT = path.resolve(__dirname, '..', '..');
const PORT = 9487;

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
        // Give the worker a moment to register.
        await sleep(4000);

        // Open the page so its content scripts and listeners are live.
        const targets0 = await httpJson(PORT, '/json/list');
        console.log('ALL TARGETS:');
        (targets0 || []).forEach(t => {
            if (t.type === 'service_worker' || (t.url || '').startsWith('chrome-extension://')) {
                console.log(`  [${t.type}] ${t.url}`);
            }
        });

        // What the extension id should be, from its manifest key.
        const expected = 'kdjgfockdecdbadmpbjgflmiffdiffhp';
        console.log('\nexpected extension id:', expected);

        const ours = (targets0 || []).find(t => (t.url || '').includes(expected));
        console.log('found our worker:', ours ? ours.url : 'NO');

        if (ours) {
            const conn = await cdp(ours.webSocketDebuggerUrl);
            await conn.send('Runtime.enable');

            const perms = await conn.send('Runtime.evaluate', {
                expression: `chrome.permissions.getAll().then(p => JSON.stringify(p))`,
                awaitPromise: true,
                returnByValue: true
            });
            console.log('OUR PERMISSIONS:', perms.result && perms.result.value);

            const dnr = await conn.send('Runtime.evaluate', {
                expression: `JSON.stringify({
                    api: typeof chrome.declarativeNetRequest,
                    rules: typeof chrome.declarativeNetRequest?.getDynamicRules
                })`,
                returnByValue: true
            });
            console.log('DNR PRESENT:', dnr.result && dnr.result.value);

            const installed = await conn.send('Runtime.evaluate', {
                expression: `chrome.declarativeNetRequest.getDynamicRules().then(r => JSON.stringify(r))`,
                awaitPromise: true,
                returnByValue: true
            });
            console.log('INSTALLED RULES:', installed.result && installed.result.value);

            conn.close();
        }
    } finally {
        await env.cleanup();
    }
})().catch(error => {
    process.stderr.write(`probe failed: ${error.message}\n`);
    process.exitCode = 1;
});
