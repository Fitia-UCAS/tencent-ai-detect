// Compares the ticket the captcha service issued with the ticket the socket carries.
//
// This is the only pair that can settle `code 21 "diff"`, and it needs both halves captured live:
//
//   * the issue: `t.captcha.qq.com/cap_union_prehandle` (and `cap_union_new_verify`) is where the
//     ticket is minted, and its response body is the only place the ticket appears before the page
//     hands it to the detection client;
//   * the send: what the page then puts on the socket, which the extension records as `relay-sent`.
//
// Reasoning about this from the trail alone kept producing wrong answers, because the trail records
// the ticket but never the request that issued it - in particular not the address that request carried,
// which is what the ticket is bound to.
//
// Read-only: one click on the detection button, which is what a user does.
const path = require('node:path');

const { resolveBrowser } = require('../machine.cjs');
const { sleep, httpJson, cdp, launch, killProfile } = require('../browser-harness.cjs');

const BROWSER = resolveBrowser();
const PORT = 9392;
const MATRIX = 'https://matrix.tencent.com/ai-detect/';
// Two levels up from tools/diagnostics: pointing at `..` would hand the browser tools/ as an extension.
const EXT = path.join(__dirname, '..', '..');

const WATCH = ['cap_union_prehandle', 'cap_union_new_verify', 'cap_union_new_getcapbysig'];

(async () => {
    const session = await launch({
        browser: BROWSER,
        port: PORT,
        prefix: 'zqticket',
        args: [
            `--load-extension=${EXT}`,
            `--disable-extensions-except=${EXT}`,
            '--no-first-run'
        ],
        url: MATRIX
    });

    console.log('browser up');

    let page;
    for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
            const targets = await httpJson(PORT, '/json/list');
            page = targets.find(t => t.type === 'page' && String(t.url).includes('matrix.tencent.com'));
            if (page) break;
        } catch (e) {
            // Not up yet.
        }
        await sleep(500);
    }

    if (!page) {
        console.log('no page target');
        await session.cleanup();
        return;
    }

    const client = await cdp(page.webSocketDebuggerUrl);
    const entries = new Map();
    const bodies = [];

    client.on(msg => {
        if (msg.method === 'Network.requestWillBeSent') {
            entries.set(msg.params.requestId, {
                url: msg.params.request.url,
                headers: msg.params.request.headers
            });
            return;
        }

        if (msg.method === 'Network.responseReceived') {
            const entry = entries.get(msg.params.requestId);
            if (entry) entry.status = msg.params.response.status;
            return;
        }

        if (msg.method !== 'Network.loadingFinished') return;

        const entry = entries.get(msg.params.requestId);
        if (!entry) return;
        if (!WATCH.some(name => entry.url.includes(name))) return;

        client.send('Network.getResponseBody', { requestId: msg.params.requestId })
            .then(result => {
                const text = result.base64Encoded
                    ? Buffer.from(result.body, 'base64').toString('utf8')
                    : result.body;
                bodies.push({ url: entry.url, status: entry.status, headers: entry.headers, body: text });
            })
            .catch(() => {});
    });

    await client.send('Network.enable', { maxPostDataSize: 65536 });
    await sleep(7000);

    // What address the extension has pinned for this tab, and what the page holds in its own storage.
    const before = await client.send('Runtime.evaluate', {
        expression: `(() => {
            const read = k => { try { return localStorage.getItem(k) || sessionStorage.getItem(k); } catch (e) { return null; } };
            return {
                identityAttr: document.documentElement.getAttribute('data-zq-xff'),
                stored: read('zq-xff')
            };
        })()`,
        returnByValue: true
    });
    console.log('page-side identity: ' + JSON.stringify(before.result.value));

    await client.send('Runtime.evaluate', {
        expression: `(() => {
            const b = Array.from(document.querySelectorAll('button'))
                .find(x => (x.textContent || '').includes('立即检测'));
            if (b) b.click();
        })()`,
        returnByValue: true
    });

    console.log('clicked; watching 30s');

    // Captured for the page's own sake, and read back from the extension's trail afterwards.
    for (let tick = 0; tick < 60; tick += 1) await sleep(500);

    console.log('');
    console.log('=== captcha service traffic ===');
    if (!bodies.length) console.log('nothing captured');

    for (const item of bodies) {
        console.log('');
        console.log(item.url.split('?')[0]);
        console.log('  status: ' + item.status);
        const fwd = (item.headers || {})['X-Forwarded-For'] || (item.headers || {})['x-forwarded-for'];
        if (fwd) console.log('  X-Forwarded-For: ' + fwd);
        console.log('  body: ' + String(item.body).slice(0, 700));
    }

    const after = await client.send('Runtime.evaluate', {
        expression: `(() => {
            const b = Array.from(document.querySelectorAll('button'))
                .find(x => (x.textContent || '').includes('立即检测'));
            return { button: b ? b.textContent.trim() : null };
        })()`,
        returnByValue: true
    });
    console.log('');
    console.log('after: ' + JSON.stringify(after.result.value));

    client.close();
    await sleep(500);
    await session.cleanup();
})().catch(async error => {
    console.log('failed: ' + (error && error.message));
    process.exitCode = 1;
});
