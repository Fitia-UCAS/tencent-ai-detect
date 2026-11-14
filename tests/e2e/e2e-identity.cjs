// Verifies the identity chain in a real browser.
//
// The pieces agree on paper (test-identity-consistency) and the relay honours a named address
// (test-relay-identity). What is left is whether the shipped extension actually wires them: the
// content script picks an address, the background installs the header rule for it, and the page's
// own request goes out carrying it.
//
// A wrong permission or a handler that never fires look identical from outside - nothing happens -
// so each stage is read back, and the request header is taken from what the browser really sends.
const path = require('node:path');

const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.resolve(__dirname, '..', '..');
const EXT_ID = process.env.EXT_ID || 'kdjgfockdecdbadmpbjgflmiffdiffhp';
const PORT = Number(process.env.IDENTITY_PORT || 9395);
const SITE = 'https://matrix.tencent.com/ai-detect/';

const { sleep, cdp, launch } = require('../../tools/browser-harness.cjs');

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log('%s %s%s', ok ? 'ok  ' : 'FAIL', name, detail ? '  - ' + detail : '');
};

async function targets() {
    return (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
}

async function waitFor(match, timeoutMs = 25000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        try {
            const found = (await targets()).find(match);
            if (found) return found;
        } catch (error) {
            // Port not up yet.
        }
        await sleep(400);
    }
    return null;
}

(async () => {
    const session = await launch({
        browser: BROWSER,
        port: PORT,
        prefix: 'zqident',
        args: [
            '--disable-features=DisableLoadExtensionCommandLineSwitch',
            `--disable-extensions-except=${EXT}`,
            `--load-extension=${EXT}`
        ]
    });

    let pageConn = null;
    let workerConn = null;

    try {
        const worker = await waitFor(t => t.type === 'service_worker' && (t.url || '').includes(EXT_ID));
        check('the service worker started with the new permissions', !!worker, worker ? worker.url : 'missing');
        if (!worker) throw new Error('worker never started');

        workerConn = await cdp(worker.webSocketDebuggerUrl);
        await sleep(1500);

        const api = await workerConn.send('Runtime.evaluate', {
            expression: `(() => ({
                dnr: typeof chrome.declarativeNetRequest,
                update: typeof (chrome.declarativeNetRequest||{}).updateDynamicRules
            }))()`,
            returnByValue: true
        });
        const apiValue = api.result?.value || {};
        check('the rule API is available',
            apiValue.dnr === 'object' && apiValue.update === 'function', JSON.stringify(apiValue));

        // Opening through the worker occasionally does not land when another browser was driven
        // moments earlier; retry rather than fail on the timing artefact.
        let page = null;
        for (let attempt = 1; attempt <= 3 && !page; attempt++) {
            const wc = await cdp(worker.webSocketDebuggerUrl);
            try {
                await wc.send('Runtime.evaluate', {
                    expression: `chrome.tabs.create({ url: ${JSON.stringify(SITE)}, active: true })`,
                    awaitPromise: true
                });
            } catch (error) {
                // A worker that went to sleep is not a reason to fail.
            } finally {
                wc.close();
            }
            page = await waitFor(t => (t.url || '').includes('matrix.tencent.com'), 30000);
        }
        check('the detection page opened', !!page);
        if (!page) throw new Error('no page');

        await sleep(9000);
        pageConn = await cdp(page.webSocketDebuggerUrl);

        const stored = await pageConn.send('Runtime.evaluate', {
            expression: `localStorage.getItem('zqXff')`,
            returnByValue: true
        });
        const identity = stored.result?.value;
        check('the page published an identity', /^\d{1,3}(\.\d{1,3}){3}$/.test(String(identity)), String(identity));

        const rules = await workerConn.send('Runtime.evaluate', {
            expression: `new Promise(r => chrome.declarativeNetRequest.getDynamicRules(rs => r(rs.map(x => ({
                id: x.id, filter: x.condition.urlFilter,
                header: (x.action.requestHeaders||[]).map(h => h.header + '=' + h.value).join(',')
            })))))`,
            awaitPromise: true,
            returnByValue: true
        });
        const ruleList = rules.result?.value || [];
        check('a header rule was installed', ruleList.length > 0, JSON.stringify(ruleList).slice(0, 200));

        check('the rule carries the same address the page published',
            ruleList.some(rule => String(rule.header).includes(String(identity))),
            'identity=' + identity + ' rules=' + JSON.stringify(ruleList.map(r => r.header)));

        // The claim that matters: the page's own request goes out carrying the same address as the
        // socket. Observe what the browser actually sends, not what the rule says it would.
        await pageConn.send('Network.enable', {});

        const sentHeaders = [];
        pageConn.on(msg => {
            if (msg.method !== 'Network.requestWillBeSentExtraInfo') return;
            const headers = msg.params?.headers || {};
            const key = Object.keys(headers).find(h => h.toLowerCase() === 'x-forwarded-for');
            if (key) sentHeaders.push(headers[key]);
        });

        await pageConn.send('Page.reload', { ignoreCache: false });
        await sleep(9000);

        const rotated = await pageConn.send('Runtime.evaluate', {
            expression: `localStorage.getItem('zqXff')`,
            returnByValue: true
        });
        const nextIdentity = rotated.result?.value;

        check('a reload picks a new address',
            /^\d{1,3}(\.\d{1,3}){3}$/.test(String(nextIdentity)) && nextIdentity !== identity,
            'before=' + identity + ' after=' + nextIdentity);

        check('the page actually sends the address the socket will use',
            sentHeaders.includes(nextIdentity),
            'sent=' + JSON.stringify([...new Set(sentHeaders)]) + ' expected=' + nextIdentity);
    } finally {
        if (pageConn) pageConn.close();
        if (workerConn) workerConn.close();
        await session.cleanup();
    }

    const failed = results.filter(ok => !ok).length;
    console.log('');
    if (failed) {
        console.error(`${failed}/${results.length} identity wiring checks failed`);
        process.exitCode = 1;
    } else {
        console.log(`PASS: ${results.length}/${results.length} identity wiring checks`);
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
