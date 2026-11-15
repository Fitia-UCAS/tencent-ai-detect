// Shows whether two tabs on the detection page can disagree about the address.
//
// "Invalid request" is the server refusing a captcha ticket issued for one address while the socket
// presents another. The identity is held in three places:
//
//   * src/content/identity.js  keeps this load's choice in memory, memoized for the whole load
//   * localStorage 'zqXff'     is per origin, so every tab of the site shares one value
//   * the DNR rules            are extension-wide: their condition carries no tabIds
//
// The last two are global, so a second tab overwrites what the first one published. The first is
// per load, so it does not follow. This tool measures that divergence directly: it reads tab A's
// memoized choice, then opens tab B, then reads A's memoized choice and the live rule again.
//
// Divergence is the failure condition, not a hint: A's next publish would put its stale address back
// on the rules while B's socket keeps the newer one, and one of the two tickets ends up refused.
const path = require('node:path');
const fs = require('node:fs');
const { sleep, httpJson, cdp, launch } = require('../browser-harness.cjs');

const EXT = path.resolve(__dirname, '..', '..');
const PORT = 9486;
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

async function ruleAddress(workerConn) {
    const result = await workerConn.send('Runtime.evaluate', {
        expression: `chrome.declarativeNetRequest.getDynamicRules().then(rules => {
            const rule = rules.find(r => r.action && r.action.requestHeaders);
            const header = rule && rule.action.requestHeaders.find(h => h.header === 'x-forwarded-for');
            return header ? header.value : null;
        })`,
        awaitPromise: true,
        returnByValue: true
    });
    return (result.result && result.result.value) || null;
}

// Opens the site in a new tab and returns a connection plus the isolated world the content scripts
// run in. Reading through that world is what makes the memoized choice visible: the page's own world
// cannot see window.__zq.
async function openTab(label) {
    const tabs = await httpJson(PORT, '/json/new?' + SITE, 'PUT');
    if (!tabs || !tabs.webSocketDebuggerUrl) throw new Error('could not open ' + label);

    const conn = await cdp(tabs.webSocketDebuggerUrl);
    const contexts = [];

    conn.on(msg => {
        if (msg.method === 'Runtime.executionContextCreated') {
            const context = msg.params.context;
            if (context.name && context.name.includes('Tencent AI Detect')) contexts.push(context);
        }
    });

    await conn.send('Runtime.enable');
    await sleep(9000);

    return { conn, contexts, label };
}

async function readState(tab) {
    const isolated = tab.contexts[tab.contexts.length - 1];
    if (!isolated) return { error: 'no isolated world' };

    const value = await tab.conn.send('Runtime.evaluate', {
        contextId: isolated.id,
        expression: `JSON.stringify({
            memory: (window.__zq && typeof window.__zq.currentIdentity === 'function')
                ? window.__zq.currentIdentity() : null,
            stored: localStorage.getItem('zqXff'),
            uses: localStorage.getItem('zqXffUses')
        })`,
        returnByValue: true
    });

    try {
        return JSON.parse(value.result.value);
    } catch (e) {
        return { error: 'unreadable: ' + String(value.result && value.result.value) };
    }
}

(async () => {
    if (!EDGE) {
        console.log('Edge not found; nothing measured.');
        return;
    }

    const session = await launch({
        browser: EDGE,
        port: PORT,
        prefix: 'zqmulti',
        args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
    });

    try {
        const worker = await findWorker();
        if (!worker) throw new Error('no extension service worker');

        const workerConn = await cdp(worker.webSocketDebuggerUrl);
        await workerConn.send('Runtime.enable');

        console.log('--- tab A opens ---');
        const a = await openTab('A');
        const a1 = await readState(a);
        const rulesA = await ruleAddress(workerConn);
        console.log('A memory   :', a1.memory);
        console.log('A stored   :', a1.stored, '| uses:', a1.uses);
        console.log('rule says  :', rulesA);

        console.log('--- tab B opens ---');
        const b = await openTab('B');
        const b1 = await readState(b);
        const rulesB = await ruleAddress(workerConn);
        console.log('B memory   :', b1.memory);
        console.log('B stored   :', b1.stored, '| uses:', b1.uses);
        console.log('rule says  :', rulesB);

        const a2 = await readState(a);
        console.log('--- after B loaded ---');
        console.log('A memory   :', a2.memory, '(was', a1.memory + ')');
        console.log('A stored   :', a2.stored);

        const verdict = [];
        if (a1.memory && b1.memory && a1.memory !== b1.memory) {
            verdict.push('two tabs chose different addresses: ' + a1.memory + ' vs ' + b1.memory);
        }
        if (a2.memory && rulesB && a2.memory !== rulesB) {
            verdict.push('tab A now disagrees with the live rule: memory ' + a2.memory + ', rule ' + rulesB);
        }
        if (b1.memory && rulesB && b1.memory !== rulesB) {
            verdict.push('tab B disagrees with the live rule: memory ' + b1.memory + ', rule ' + rulesB);
        }

        console.log('--- verdict ---');
        if (verdict.length) {
            verdict.forEach(line => console.log('  DIVERGED  ' + line));
            console.log('One of these tabs will get "Invalid request": the ticket is issued under the');
            console.log('rule address while the socket carries the one its own load published.');
        } else {
            console.log('  consistent: every tab and the live rule agree in this run');
        }

        a.conn.close();
        b.conn.close();
        workerConn.close();
    } finally {
        await session.cleanup();
    }
})().catch(error => {
    process.stdout.write('diagnostic failed: ' + (error && error.message ? error.message : error) + '\n');
    process.exitCode = 1;
});
