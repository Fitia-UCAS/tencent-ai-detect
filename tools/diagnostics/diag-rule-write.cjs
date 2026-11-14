// Asks the service worker directly why the header rules are not installed.
//
// The diagnostic showed the page choosing an address while getDynamicRules() returned nothing, so
// the rule write is failing and its error is being swallowed by the callback. This calls the same
// API from the worker and reports the thrown message.
const path = require('node:path');
const fs = require('node:fs');
const { sleep, httpJson, cdp, launch } = require('../browser-harness.cjs');

const EXT = path.resolve(__dirname, '..', '..');
const PORT = 9486;

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
        let workerConn = null;
        for (let i = 0; i < 40 && !workerConn; i += 1) {
            const targets = await httpJson(PORT, '/json/list');

            // Matching on "background" alone attaches to Edge's own internal workers, whose
            // permission sets and APIs are not the extension's. The origin is what identifies it.
            const sw = (targets || []).find(t =>
                t.type === 'service_worker' &&
                (t.url || '').startsWith('chrome-extension://') &&
                (t.url || '').includes('/background'));

            if (sw) {
                console.log('worker:', sw.url);
                workerConn = await cdp(sw.webSocketDebuggerUrl);
            } else {
                await sleep(300);
            }
        }
        if (!workerConn) throw new Error('no extension service worker');

        await workerConn.send('Runtime.enable');

        // Write a rule exactly as the extension does, and report what the API says about it.
        const write = await workerConn.send('Runtime.evaluate', {
            expression: `(async () => {
                const rules = [{
                    id: 991,
                    priority: 1,
                    action: {
                        type: 'modifyHeaders',
                        requestHeaders: [{ header: 'x-forwarded-for', operation: 'set', value: '183.192.101.227' }]
                    },
                    condition: {
                        urlFilter: '||matrix.tencent.com',
                        resourceTypes: ['xmlhttprequest', 'websocket', 'sub_frame', 'other']
                    }
                }];

                try {
                    await chrome.declarativeNetRequest.updateDynamicRules({
                        removeRuleIds: [991],
                        addRules: rules
                    });
                    return JSON.stringify({ ok: true });
                } catch (error) {
                    return JSON.stringify({ ok: false, error: String(error && error.message || error) });
                }
            })()`,
            awaitPromise: true,
            returnByValue: true
        });

        console.log('WRITE:', (write.result && write.result.value) || '(empty)');

        const after = await workerConn.send('Runtime.evaluate', {
            expression: `chrome.declarativeNetRequest.getDynamicRules().then(r => JSON.stringify(r.map(x => x.id)))`,
            awaitPromise: true,
            returnByValue: true
        });

        console.log('RULES NOW:', (after.result && after.result.value) || '(none)');

        // Whether the extension is even allowed the permission it needs.
        const perms = await workerConn.send('Runtime.evaluate', {
            expression: `chrome.permissions.getAll().then(p => JSON.stringify(p))`,
            awaitPromise: true,
            returnByValue: true
        });

        console.log('PERMISSIONS:', (perms.result && perms.result.value) || '(none)');

        workerConn.close();
    } finally {
        await env.cleanup();
    }
})().catch(error => {
    process.stderr.write(`probe failed: ${error.message}\n`);
    process.exitCode = 1;
});
