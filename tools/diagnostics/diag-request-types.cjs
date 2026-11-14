// Records what the captcha and detection requests actually are, and whether the address header
// reached them.
//
// The header rule covers a fixed list of resource types. If the captcha ticket is fetched as a type
// outside that list, it never gets the header, so the ticket is issued for the real address while
// the socket carries the synthetic one - and the server refuses the detection with "Invalid
// request" no matter how well the rest is wired. Only the wire can say which type it is.
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

        const requests = new Map();
        const headers = new Map();

        pageConn.on(msg => {
            if (msg.method === 'Network.requestWillBeSent') {
                const r = msg.params.request;
                const id = msg.params.requestId;
                if (/captcha|getClassify|ai_gen_txt|gtimg/i.test(r.url)) {
                    requests.set(id, { url: r.url, type: msg.params.type, viaServiceWorker: msg.params.requestId });
                }
            }
            if (msg.method === 'Network.requestWillBeSentExtraInfo') {
                const id = msg.params.requestId;
                const h = msg.params.headers || {};
                const found = Object.keys(h).find(k => k.toLowerCase() === 'x-forwarded-for');
                headers.set(id, found ? String(h[found]) : null);
            }
        });

        await pageConn.send('Network.enable', {});
        await pageConn.send('Runtime.enable');

        // Reload under observation so the ticket fetch happens with the recorder attached.
        await pageConn.send('Page.enable');
        await pageConn.send('Page.reload', { ignoreCache: true });
        await sleep(12000);

        console.log('captured', requests.size, 'requests of interest');
        for (const [id, info] of requests) {
            const xff = headers.has(id) ? headers.get(id) : '(no extra info)';
            console.log(`  [${info.type}] xff=${xff} :: ${info.url.slice(0, 110)}`);
        }

        const typesSeen = [...new Set([...requests.values()].map(r => r.type))];
        console.log('\nresource types seen:', typesSeen.join(', ') || '(none)');

        pageConn.close();
        workerConn.close();
    } finally {
        await env.cleanup();
    }
})().catch(error => {
    process.stderr.write(`probe failed: ${error.message}\n`);
    process.exitCode = 1;
});
