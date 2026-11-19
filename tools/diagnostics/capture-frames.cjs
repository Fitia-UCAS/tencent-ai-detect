// Follows one detection press end to end: the ticket the page obtains, the frame the shim sends, and
// the server's verdict.
//
// The previous attempt captured the captcha service's own traffic and showed what the ticket question
// actually looks like: `cap_union_prehandle` answers with `"ticket":""` and a `sess` token, and it runs
// more than once per press (subcapclass 1003, then 1865). So the ticket on the wire is not the thing
// prehandle returns - it is minted after the challenge is answered.
//
// That means the only reliable way to see the pairing is to watch the shim's own send, because the shim
// sits between the page and the socket. This taps it from inside the page: the extension already
// dispatches `zq:relay-sent` for every outbound frame, so a listener on that event sees exactly what
// goes to the server, alongside the address the tab has pinned.
//
// Read-only: one click, the same thing a user does.
const path = require('node:path');

const { resolveBrowser } = require('../machine.cjs');
const { sleep, httpJson, cdp, launch, killProfile } = require('../browser-harness.cjs');

const BROWSER = resolveBrowser();
const PORT = 9393;
const MATRIX = 'https://matrix.tencent.com/ai-detect/';
const EXT = path.join(__dirname, '..', '..');

(async () => {
    const session = await launch({
        browser: BROWSER,
        port: PORT,
        prefix: 'zqframe',
        args: [
            `--load-extension=${EXT}`,
            `--disable-extensions-except=${EXT}`,
            '--no-first-run'
        ],
        url: MATRIX
    });

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
    await client.send('Runtime.enable');
    await sleep(7000);

    // Install the tap before pressing, so nothing is missed. The extension dispatches these events
    // itself; this only listens.
    await client.send('Runtime.evaluate', {
        expression: `(() => {
            window.__zqCapture = [];
            const note = (kind, text) => {
                window.__zqCapture.push({ kind, at: Date.now(), text: String(text).slice(0, 900) });
            };
            window.addEventListener('zq:relay-sent', e => note('sent', e.detail));
            window.addEventListener('zq:relay-frame', e => note('frame', e.detail));
            window.addEventListener('zq:quick-pass', e => {
                note('quick-pass', JSON.stringify(e.detail && { ticketLength: e.detail.ticketLength }));
            });
            return 'installed';
        })()`,
        returnByValue: true
    });

    console.log('tap installed; pressing detect');

    await client.send('Runtime.evaluate', {
        expression: `(() => {
            const b = Array.from(document.querySelectorAll('button'))
                .find(x => (x.textContent || '').includes('立即检测'));
            if (b) b.click();
            return b ? 'clicked' : 'no button';
        })()`,
        returnByValue: true
    });

    // Long enough for a challenge to be solved by hand if one appears; this run only needs the frames
    // that come back on their own.
    for (let tick = 0; tick < 50; tick += 1) await sleep(500);

    const captured = await client.send('Runtime.evaluate', {
        expression: 'JSON.stringify(window.__zqCapture || [])',
        returnByValue: true
    });

    const identity = await client.send('Runtime.evaluate', {
        expression: `(() => ({
            attr: document.documentElement.getAttribute('data-zq-xff'),
            state: window.__zq && typeof window.__zq.pageState === 'function' ? window.__zq.pageState() : null,
            captchaOpen: window.__zq && typeof window.__zq.captchaOpen === 'function' ? window.__zq.captchaOpen() : null
        }))()`,
        returnByValue: true
    });

    console.log('');
    console.log('tab identity: ' + JSON.stringify(identity.result.value));
    console.log('');

    let items = [];
    try {
        items = JSON.parse(captured.result.value || '[]');
    } catch (e) {
        console.log('capture unreadable: ' + captured.result.value);
    }

    console.log('=== frames observed (' + items.length + ') ===');
    let base = items.length ? items[0].at : 0;
    for (const item of items) {
        const rel = ((item.at - base) / 1000).toFixed(1);
        let shown = item.text;
        // Tickets are long and the useful part is the shape, not the signature.
        const match = shown.match(/"ticket":"([^"]*)"/);
        if (match) {
            shown = shown.replace(match[0], `"ticket":"<len ${match[1].length}>"`);
        }
        console.log('+' + rel + 's  ' + item.kind.padEnd(11) + shown.slice(0, 220));
    }

    client.close();
    await sleep(500);
    await session.cleanup();
})().catch(async error => {
    console.log('failed: ' + (error && error.message));
    process.exitCode = 1;
});
