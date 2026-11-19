// What distinguishes a ticket the detection endpoint accepts from one it answers `code 21` to.
//
// Measured live, on one press: the site handed the page a 130-character ticket with no challenge at
// all, the shim put it on the socket, and the server answered `code 21 "diff"` 200ms later. So the
// short ticket is not a symptom of anything this extension does - the page obtained it before any
// captcha request was made.
//
// What is still open is what the page does differently when it eventually obtains a usable one. This
// captures that transition: it presses, waits out whatever comes back, and records every ticket the
// page obtains together with the captcha traffic in between, so the two states can be compared on the
// same run rather than across runs.
//
// Read-only: presses the detection button, the same thing a user does.
const path = require('node:path');

const { resolveBrowser } = require('../machine.cjs');
const { sleep, httpJson, cdp, launch, killProfile } = require('../browser-harness.cjs');

const BROWSER = resolveBrowser();
const PORT = 9394;
const MATRIX = 'https://matrix.tencent.com/ai-detect/';
const EXT = path.join(__dirname, '..', '..');

(async () => {
    const session = await launch({
        browser: BROWSER,
        port: PORT,
        prefix: 'zqpair',
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
    await client.send('Network.enable');

    const captcha = [];

    client.on(msg => {
        if (msg.method !== 'Network.requestWillBeSent') return;
        const url = msg.params.request.url;
        if (!url.includes('captcha')) return;
        if (captcha.some(entry => entry.url === url)) return;
        captcha.push({ at: Date.now(), url: url.split('?')[0], query: url.slice(url.indexOf('?') + 1, 260) });
    });

    await sleep(7000);

    await client.send('Runtime.evaluate', {
        expression: `(() => {
            window.__zqCapture = [];
            const note = (kind, text) => window.__zqCapture.push({ kind, at: Date.now(), text: String(text).slice(0, 900) });
            window.addEventListener('zq:relay-sent', e => note('sent', e.detail));
            window.addEventListener('zq:relay-frame', e => note('frame', e.detail));
            return 'installed';
        })()`,
        returnByValue: true
    });

    const press = async label => {
        await client.send('Runtime.evaluate', {
            expression: `(() => {
                const b = Array.from(document.querySelectorAll('button'))
                    .find(x => (x.textContent || '').includes('立即检测'));
                if (b && !b.disabled) { b.click(); return 'clicked'; }
                return b ? 'disabled: ' + b.textContent.trim() : 'no button';
            })()`,
            returnByValue: true
        });
        console.log('press: ' + label);
    };

    console.log('--- press 1 ---');
    await press('first');

    // Whatever comes back, wait, then press again: the site's own recovery is part of what is measured.
    for (let round = 0; round < 3; round += 1) {
        for (let tick = 0; tick < 20; tick += 1) await sleep(500);
        const state = await client.send('Runtime.evaluate', {
            expression: `(() => ({
                state: window.__zq && typeof window.__zq.pageState === 'function' ? window.__zq.pageState() : null,
                button: (Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').includes('立即检测')) || {}).textContent
            }))()`,
            returnByValue: true
        });
        console.log('  state: ' + JSON.stringify(state.result.value));
        console.log('--- press ' + (round + 2) + ' ---');
        await press('round ' + (round + 2));
    }

    const captured = await client.send('Runtime.evaluate', {
        expression: 'JSON.stringify(window.__zqCapture || [])',
        returnByValue: true
    });

    let items = [];
    try {
        items = JSON.parse(captured.result.value || '[]');
    } catch (e) {
        // Left empty; the captcha list below still prints.
    }

    const base = items.length ? items[0].at : Date.now();

    console.log('');
    console.log('=== timeline ===');
    const merged = [];
    for (const item of items) merged.push({ at: item.at, kind: item.kind, text: item.text });
    for (const entry of captcha) merged.push({ at: entry.at, kind: 'captcha', text: entry.url });
    merged.sort((a, b) => a.at - b.at);

    for (const item of merged) {
        const rel = ((item.at - base) / 1000).toFixed(1);
        let shown = item.text;
        const match = shown.match(/"ticket":"([^"]*)"/);
        if (match) shown = shown.replace(match[0], `"ticket":"<len ${match[1].length}>"`);
        console.log('+' + rel + 's  ' + item.kind.padEnd(10) + shown.slice(0, 180));
    }

    client.close();
    await sleep(500);
    await session.cleanup();
})().catch(async error => {
    console.log('failed: ' + (error && error.message));
    process.exitCode = 1;
});
