// Records what the captcha and detection requests actually are, and whether the address header
// reached them.
//
// The header rule covers a fixed list of resource types. If a request that the ticket depends on is
// fetched as a type outside that list, it never gets the header, the ticket is issued for the real
// address while the socket carries the synthetic one, and the server refuses the detection with
// "Invalid request" no matter how well the rest is wired. Only the wire can say which type it is.
//
// Cross-process iframes are separate targets, and the captcha is one. Watching only the page target
// therefore misses exactly the requests this is meant to measure, so every attached target is
// watched. Two things make that work:
//
//   * The same requestId can appear in different sessions and mean different requests, so the
//     correlation key is (sessionId, requestId), never requestId alone.
//   * requestWillBeSentExtraInfo is not guaranteed to arrive, and does not arrive in a fixed order
//     relative to requestWillBeSent. Requests and headers are collected separately and joined when
//     printing, so an early or missing piece cannot lose the record.
const path = require('node:path');
const fs = require('node:fs');
const { sleep, httpJson, cdp, launch } = require('../browser-harness.cjs');

const EXT = path.resolve(__dirname, '..', '..');
const PORT = 9488;
const SITE = 'https://matrix.tencent.com/ai-detect/';
const EXT_ID = 'kdjgfockdecdbadmpbjgflmiffdiffhp';
const OBSERVE_MS = 12000;

const EDGE = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

const INTERESTING = /captcha|getClassify|ai_gen_txt|gtimg/i;

// A request is identified by the session that observed it plus its requestId. The same requestId
// under two sessions is two different requests.
function keyOf(sessionId, requestId) {
    return JSON.stringify([sessionId || 'root', requestId]);
}

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
            const sw = (targets || []).find(t => t.type === 'service_worker' && (t.url || '').includes(EXT_ID));
            if (sw) workerConn = await cdp(sw.webSocketDebuggerUrl);
            else await sleep(300);
        }
        if (!workerConn) throw new Error('no extension worker');

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
        if (!page) throw new Error('page never opened');

        const pageConn = await cdp(page.webSocketDebuggerUrl);

        const sessions = new Map();   // sessionId -> { url, type }
        const requests = new Map();   // key -> { sessionId, requestId, url, type, redirects }
        const headers = new Map();    // key -> [ xff or null, ... ] one entry per hop

        function record(sessionId, params) {
            const key = keyOf(sessionId, params.requestId);
            const url = params.request && params.request.url ? params.request.url : '';

            if (!INTERESTING.test(url)) return;

            const previous = requests.get(key);
            if (previous && params.redirectResponse) {
                // A redirect keeps the same requestId. Overwriting would hide the hop that carried
                // the ticket, so the hops are kept as a list.
                previous.redirects.push({ url: previous.url, status: params.redirectResponse.status });
            }

            requests.set(key, {
                sessionId: sessionId || 'root',
                requestId: params.requestId,
                url,
                type: params.type,
                redirects: previous ? previous.redirects : []
            });
        }

        function recordHeaders(sessionId, params) {
            const key = keyOf(sessionId, params.requestId);
            const found = Object.keys(params.headers || {})
                .find(name => name.toLowerCase() === 'x-forwarded-for');

            const hop = found ? String(params.headers[found]) : null;
            const list = headers.get(key) || [];
            list.push(hop);
            headers.set(key, list);
        }

        async function watch(sessionId) {
            await pageConn.send('Network.enable', {}, sessionId);
            // Flattened auto-attach covers the targets attached to this one. A cross-process frame
            // nested deeper needs its own auto-attach, so it is armed on every child as it arrives.
            await pageConn.send('Target.setAutoAttach', {
                autoAttach: true,
                waitForDebuggerOnStart: false,
                flatten: true
            }, sessionId);
        }

        pageConn.on(msg => {
            const sessionId = msg.sessionId;

            if (msg.method === 'Target.attachedToTarget') {
                const child = msg.params.sessionId;
                sessions.set(child, { url: msg.params.targetInfo.url, type: msg.params.targetInfo.type });
                watch(child).catch(() => {});
                return;
            }

            if (msg.method === 'Target.detachedFromTarget') {
                sessions.delete(msg.params.sessionId);
                return;
            }

            if (msg.method === 'Network.requestWillBeSent') {
                record(sessionId, msg.params);
                return;
            }

            if (msg.method === 'Network.requestWillBeSentExtraInfo') {
                recordHeaders(sessionId, msg.params);
            }
        });

        await watch(undefined);

        // Reload under observation so the ticket fetch happens with the recorder attached.
        await pageConn.send('Page.enable');
        await pageConn.send('Page.reload', { ignoreCache: true });
        await sleep(OBSERVE_MS);

        console.log('sessions watched:', sessions.size + 1, '(page + attached frames)');
        console.log('captured', requests.size, 'requests of interest\n');

        const missing = [];
        for (const [key, info] of requests) {
            const hops = headers.get(key);
            const xff = hops ? hops[hops.length - 1] : '(no extra info)';
            if (hops && hops.includes(null)) missing.push(info);

            const hopsLabel = info.redirects.length
                ? ' via ' + info.redirects.map(r => `${r.status} ${r.url.slice(0, 40)}`).join(' -> ')
                : '';
            console.log(`  [${info.type}] xff=${xff} :: ${info.url.slice(0, 100)}${hopsLabel}`);
        }

        const typesSeen = [...new Set([...requests.values()].map(r => r.type))];
        console.log('\nresource types seen:', typesSeen.join(', ') || '(none)');

        if (missing.length) {
            console.log('\nrequests that reached the wire WITHOUT the address header:');
            for (const info of missing) console.log(`  [${info.type}] ${info.url.slice(0, 100)}`);
            console.log('\nIf any of these is what issues the captcha ticket, the resource type is');
            console.log('missing from COVERED_RESOURCE_TYPES in src/background/identity.js.');
        }

        pageConn.close();
        workerConn.close();
    } finally {
        await env.cleanup();
    }
})().catch(error => {
    process.stderr.write(`probe failed: ${error.message}\n`);
    process.exitCode = 1;
});
