// Determines which rule type accepts `tabIds` in its condition, by asking the browser.
//
// The whole per-tab isolation design depends on this: if dynamic rules reject tabIds, the rules
// have to move to the session ruleset, which changes their lifetime and their ID handling. Rather
// than trust a remembered constraint, both calls are made against a real browser and the rejection
// message is printed.
const path = require('node:path');
const { sleep, httpJson, cdp, launch } = require('../browser-harness.cjs');

const EXT = path.resolve(__dirname, '..', '..');
const PORT = 9487;
const EXT_ID = 'kdjgfockdecdbadmpbjgflmiffdiffhp';

const { resolveBrowser } = require('../machine.cjs');
const BROWSER = resolveBrowser();

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

const RULE = tabIds => `[
    {
        id: 9001,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [
            { header: 'x-forwarded-for', operation: 'set', value: '203.0.113.7' }
        ]},
        condition: {
            urlFilter: '||example.com',
            resourceTypes: ['xmlhttprequest'],
            tabIds: [${tabIds}]
        }
    }
]`;

(async () => {
    const session = await launch({
        browser: BROWSER,
        port: PORT,
        prefix: 'zqtabids',
        args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
    });

    try {
        const worker = await findWorker();
        if (!worker) throw new Error('no service worker');

        const conn = await cdp(worker.webSocketDebuggerUrl);
        await conn.send('Runtime.enable');

        // A real tab id, so the value is not rejected merely for being invented.
        const created = await conn.send('Runtime.evaluate', {
            expression: `chrome.tabs.create({ url: 'about:blank' }).then(t => t.id)`,
            awaitPromise: true,
            returnByValue: true
        });
        const tabId = (created.result && created.result.value);
        console.log('tabId used:', tabId);

        async function attempt(label, expression) {
            const result = await conn.send('Runtime.evaluate', {
                expression,
                awaitPromise: true,
                returnByValue: true
            });
            if (result.exceptionDetails) {
                const text = result.exceptionDetails.exception &&
                    result.exceptionDetails.exception.description;
                console.log(label + ': REJECTED -> ' + String(text || result.exceptionDetails.text).split('\n')[0]);
                return false;
            }
            console.log(label + ': ACCEPTED');
            return true;
        }

        await attempt('updateDynamicRules + tabIds',
            `chrome.declarativeNetRequest.updateDynamicRules({
                removeRuleIds: [9001],
                addRules: ${RULE(tabId)}
            }).then(() => 'ok')`);

        await attempt('updateSessionRules + tabIds',
            `chrome.declarativeNetRequest.updateSessionRules({
                removeRuleIds: [9001],
                addRules: ${RULE(tabId)}
            }).then(() => 'ok')`);

        // What the browser actually ended up holding, so acceptance is not the only evidence.
        const held = await conn.send('Runtime.evaluate', {
            expression: `Promise.all([
                chrome.declarativeNetRequest.getDynamicRules(),
                chrome.declarativeNetRequest.getSessionRules()
            ]).then(([d, s]) => JSON.stringify({
                dynamic: d.map(r => r.id),
                session: s.map(r => r.id)
            }))`,
            awaitPromise: true,
            returnByValue: true
        });
        console.log('held:', (held.result && held.result.value) || '(none)');

        // Clean up the probe rules so nothing is left behind in this profile.
        await conn.send('Runtime.evaluate', {
            expression: `Promise.all([
                chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [9001] }),
                chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [9001] })
            ]).then(() => 'cleaned')`,
            awaitPromise: true,
            returnByValue: true
        });

        conn.close();
    } finally {
        await session.cleanup();
    }
})().catch(error => {
    process.stdout.write('probe failed: ' + (error && error.message ? error.message : error) + '\n');
    process.exitCode = 1;
});
