// Shows whether two tabs on the detection page can disagree about the address.
//
// "Invalid request" is the server refusing a captcha ticket issued for one address while the socket
// presents another. The address is held in three places:
//
//   * src/content/identity.js  keeps this load's choice in memory, memoized for the whole load
//   * the session DNR rules    one rule set per tab, condition.tabIds naming that tab
//   * the per-tab surfaces     a data-zq-xff attribute on <html> and sessionStorage
//
// The rules used to be one global set carrying whichever load published last, while the first tab
// kept its own address in memory. That produced divergence by construction: the first tab's next
// publish put its stale address back on the rules while the other tab's socket carried the newer
// one. This tool measures the three directly.
//
// Each tab is checked against its OWN rules, not against the newest rule set, because the rules are
// per tab now. Divergence is the failure condition: it means one of these tabs will be refused.
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

// The address this tab's rules carry, read from the ruleset the browser actually holds.
async function ruleAddressFor(workerConn, tabId) {
    const result = await workerConn.send('Runtime.evaluate', {
        expression: `chrome.declarativeNetRequest.getSessionRules().then(rules => {
            const mine = rules.filter(r => {
                const tabIds = r.condition && r.condition.tabIds;
                return Array.isArray(tabIds) && tabIds.length === 1 && tabIds[0] === ${tabId};
            });
            const values = mine
                .map(r => ((r.action.requestHeaders || []).find(h => h.header === 'x-forwarded-for') || {}).value)
                .filter(Boolean);
            const unique = Array.from(new Set(values));
            return JSON.stringify({ count: mine.length, values: unique });
        })`,
        awaitPromise: true,
        returnByValue: true
    });

    try {
        return JSON.parse(result.result.value);
    } catch (e) {
        return { count: 0, values: [], error: String(result.result && result.result.value) };
    }
}

// Opens the site in a new tab and returns its tab id, a CDP connection, and the isolated world the
// content scripts run in. Creating it from the worker is what makes the tab id known.
async function openTab(workerConn, usedTargets, label) {
    const created = await workerConn.send('Runtime.evaluate', {
        expression: `chrome.tabs.create({ url: ${JSON.stringify(SITE)}, active: false }).then(t => t.id)`,
        awaitPromise: true,
        returnByValue: true
    });

    const tabId = created.result && created.result.value;
    if (!Number.isInteger(tabId)) throw new Error('could not create ' + label);

    let target = null;
    for (let i = 0; i < 40 && !target; i += 1) {
        const targets = await httpJson(PORT, '/json/list');
        target = (targets || []).find(t =>
            t.type === 'page' &&
            (t.url || '').includes('matrix.tencent.com') &&
            !usedTargets.has(t.id));
        if (!target) await sleep(300);
    }

    if (!target) throw new Error('no CDP target for ' + label);
    usedTargets.add(target.id);

    const conn = await cdp(target.webSocketDebuggerUrl);
    const contexts = [];

    conn.on(msg => {
        if (msg.method === 'Runtime.executionContextCreated') {
            const context = msg.params.context;
            if (context.name && context.name.includes('Tencent AI Detect')) contexts.push(context);
        }
    });

    await conn.send('Runtime.enable');
    await sleep(9000);

    return { conn, contexts, label, tabId };
}

async function readState(tab) {
    const isolated = tab.contexts[tab.contexts.length - 1];
    if (!isolated) return { error: 'no isolated world' };

    const value = await tab.conn.send('Runtime.evaluate', {
        contextId: isolated.id,
        expression: `JSON.stringify({
            memory: (window.__zq && typeof window.__zq.currentIdentity === 'function')
                ? window.__zq.currentIdentity() : null,
            attr: document.documentElement ? document.documentElement.getAttribute('data-zq-xff') : null,
            session: sessionStorage.getItem('zqXff'),
            shared: localStorage.getItem('zqXff'),
            uses: sessionStorage.getItem('zqXffUses')
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

        const used = new Set();
        const problems = [];

        console.log('--- tab A opens ---');
        const a = await openTab(workerConn, used, 'A');
        const a1 = await readState(a);
        const ruleA1 = await ruleAddressFor(workerConn, a.tabId);
        console.log('A tab id   :', a.tabId);
        console.log('A memory   :', a1.memory);
        console.log('A attr     :', a1.attr, '| session:', a1.session, '| shared:', a1.shared);
        console.log('A rules    :', JSON.stringify(ruleA1));

        console.log('--- tab B opens ---');
        const b = await openTab(workerConn, used, 'B');
        const b1 = await readState(b);
        const ruleB1 = await ruleAddressFor(workerConn, b.tabId);
        console.log('B tab id   :', b.tabId);
        console.log('B memory   :', b1.memory);
        console.log('B attr     :', b1.attr, '| session:', b1.session, '| shared:', b1.shared);
        console.log('B rules    :', JSON.stringify(ruleB1));

        const a2 = await readState(a);
        const ruleA2 = await ruleAddressFor(workerConn, a.tabId);
        console.log('--- after B loaded ---');
        console.log('A memory   :', a2.memory, '(was', a1.memory + ')');
        console.log('A attr     :', a2.attr, '| session:', a2.session, '| shared:', a2.shared);
        console.log('A rules    :', JSON.stringify(ruleA2));

        // Each tab must agree with its own rules. Comparing a tab against another tab's rules would
        // be wrong now: separate rule sets are the point.
        function agree(label, state, rule) {
            if (state.error) {
                problems.push(label + ': ' + state.error);
                return;
            }
            if (rule.count !== 3) {
                problems.push(label + ': expected 3 rules for its tab, found ' + rule.count);
                return;
            }
            if (rule.values.length !== 1) {
                problems.push(label + ': its rules carry more than one address: ' + rule.values.join(', '));
                return;
            }
            if (state.memory && state.memory !== rule.values[0]) {
                problems.push(label + ': memory ' + state.memory + ' but its rules say ' + rule.values[0]);
            }
            if (state.attr && state.attr !== rule.values[0]) {
                problems.push(label + ': attribute ' + state.attr + ' but its rules say ' + rule.values[0]);
            }
        }

        agree('tab A after B loaded', a2, ruleA2);
        agree('tab B', b1, ruleB1);

        console.log('--- verdict ---');
        if (problems.length) {
            problems.forEach(line => console.log('  DIVERGED  ' + line));
            console.log('A tab whose memory and rules disagree gets "Invalid request": the ticket is');
            console.log('issued under the rule address while the socket carries the other one.');
            process.exitCode = 1;
        } else {
            console.log('  isolated: every tab agrees with its own rules');
            console.log('  A kept ' + ruleA2.values[0] + ' while B moved to ' + ruleB1.values[0]);
            if (a2.shared !== null) {
                console.log('  (localStorage still shows ' + a2.shared + '; nothing reads it for the address)');
            }
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
