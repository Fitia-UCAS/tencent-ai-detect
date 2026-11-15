// Reads the live identity state from a real page load and reports what disagrees.
//
// This exists because "Invalid request" names none of its three inputs. The captcha ticket is issued
// for the address the header rule injected, and the socket presents the address the shim read; when
// those differ the server refuses, and the page only says so in prose. Everything needed to tell
// which one is wrong is read here in one pass, from the page and from the worker.
//
// The page is opened as the browser's own start page rather than created through chrome.tabs.create,
// because a background tab is not guaranteed to run the content scripts, and a probe that reads
// nothing is worse than no probe.
const path = require('node:path');
const { sleep, httpJson, cdp, launch } = require('../browser-harness.cjs');

const EXT = path.resolve(__dirname, '..', '..');
const PORT = 9491;
const SITE = 'https://matrix.tencent.com/ai-detect/';
const EXT_ID = 'kdjgfockdecdbadmpbjgflmiffdiffhp';

const { resolveBrowser } = require('../machine.cjs');
const BROWSER = resolveBrowser();

async function findWorker() {
    for (let i = 0; i < 60; i += 1) {
        const targets = await httpJson(PORT, '/json/list');
        const sw = (targets || []).find(t =>
            t.type === 'service_worker' && (t.url || '').includes(EXT_ID));
        if (sw) return sw;
        await sleep(300);
    }
    return null;
}

(async () => {
    const session = await launch({
        browser: BROWSER,
        port: PORT,
        prefix: 'zqdiag',
        args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
        url: SITE
    });

    try {
        const worker = await findWorker();
        if (!worker) throw new Error('no extension service worker');
        const workerConn = await cdp(worker.webSocketDebuggerUrl);
        await workerConn.send('Runtime.enable');

        let page = null;
        for (let i = 0; i < 80 && !page; i += 1) {
            const targets = await httpJson(PORT, '/json/list');
            page = (targets || []).find(t => t.type === 'page' && (t.url || '').includes('matrix.tencent.com'));
            if (!page) await sleep(300);
        }
        if (!page) throw new Error('no page target for the site');

        const conn = await cdp(page.webSocketDebuggerUrl);
        const contexts = [];
        conn.on(msg => {
            if (msg.method === 'Runtime.executionContextCreated') {
                const context = msg.params.context;
                if (context.name && context.name.includes('Tencent AI Detect')) contexts.push(context);
            }
        });

        await conn.send('Runtime.enable');
        // The page's own bundle, the captcha SDK and the first tick all have to have run.
        await sleep(12000);

        const isolated = contexts[contexts.length - 1];
        if (!isolated) throw new Error('no isolated world: the content scripts did not run');

        const pageState = await conn.send('Runtime.evaluate', {
            contextId: isolated.id,
            expression: `JSON.stringify({
                confirmed: window.__zq.state.identityConfirmed,
                memory: typeof window.__zq.currentIdentity === 'function' ? window.__zq.currentIdentity() : null,
                attr: document.documentElement.getAttribute('data-zq-xff'),
                session: sessionStorage.getItem('zqXff'),
                shared: localStorage.getItem('zqXff'),
                uses: document.documentElement.getAttribute('data-zq-xff-uses'),
                usesSession: sessionStorage.getItem('zqXffUses'),
                pageState: typeof window.__zq.pageState === 'function' ? window.__zq.pageState() : null,
                quota: typeof window.__zq.readQuota === 'function' ? window.__zq.readQuota() : null,
                spent: typeof window.__zq.identitySpent === 'function' ? window.__zq.identitySpent() : 'NO identitySpent',
                autoRefresh: window.__zq.state.autoRefresh,
                enabled: window.__zq.state.enabled
            })`,
            returnByValue: true
        });

        const live = await workerConn.send('Runtime.evaluate', {
            expression: `Promise.all([
                chrome.declarativeNetRequest.getSessionRules(),
                chrome.declarativeNetRequest.getDynamicRules(),
                chrome.tabs.query({})
            ]).then(([sessionRules, dynamicRules, tabs]) => JSON.stringify({
                sessionRules: sessionRules.map(r => ({
                    id: r.id,
                    tabIds: r.condition && r.condition.tabIds,
                    xff: ((r.action.requestHeaders || [])[0] || {}).value
                })),
                dynamicCount: dynamicRules.length,
                openTabs: tabs.length
            }))`,
            awaitPromise: true,
            returnByValue: true
        });

        const s = JSON.parse(pageState.result.value);
        const live_ = JSON.parse(live.result.value);

        console.log('=== the page says ===');
        console.log(JSON.stringify(s, null, 1));
        console.log('=== the browser holds ===');
        console.log(JSON.stringify(live_, null, 1));

        console.log('=== verdict ===');
        const problems = [];

        if (live_.sessionRules.length === 0) {
            problems.push('no session rules at all: the header rule was never installed');
        }

        for (const rule of live_.sessionRules) {
            if (!Array.isArray(rule.tabIds) || rule.tabIds.length !== 1) {
                problems.push('rule ' + rule.id + ' is not scoped to a tab: ' + JSON.stringify(rule.tabIds));
            }
        }

        const ruleAddresses = [...new Set(live_.sessionRules.map(r => r.xff).filter(Boolean))];
        if (ruleAddresses.length > 1) {
            problems.push('the rules carry more than one address: ' + ruleAddresses.join(', '));
        }

        const ruleAddress = ruleAddresses[0] || null;

        if (ruleAddress && s.memory && ruleAddress !== s.memory) {
            problems.push('the rule says ' + ruleAddress + ' but this load chose ' + s.memory);
        }

        const socketAddress = s.attr || s.session || s.shared;
        if (!socketAddress) {
            problems.push('the socket would carry no address: the relay would draw a random one');
        } else if (ruleAddress && socketAddress !== ruleAddress) {
            problems.push('the socket would carry ' + socketAddress + ' but the rule injects ' + ruleAddress);
        }

        if (s.confirmed === false) {
            problems.push('the worker never confirmed this address');
        }

        if (problems.length) {
            problems.forEach(line => console.log('  BROKEN  ' + line));
            process.exitCode = 1;
        } else {
            console.log('  consistent: rule, load and socket all carry ' + ruleAddress);
        }

        conn.close();
        workerConn.close();
    } finally {
        await session.cleanup();
    }
})().catch(error => {
    process.stdout.write('diag failed: ' + (error && error.message ? error.message : error) + '\n');
    process.exitCode = 1;
});
