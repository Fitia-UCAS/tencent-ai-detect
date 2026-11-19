// One clean press, measured in the world the events actually live in.
//
// Two measurement errors came before this file and both produced wrong conclusions:
//
//   1. The content script was read from the debugger's default context and reported absent. It was
//      present in the isolated world; `chrome.scripting.executeScript` shows ISOLATED { ready: true }
//      and MAIN { __zqRelayShim: true } side by side.
//   2. The relay events were then tapped from the isolated world. But `zq:relay-sent` is dispatched by
//      the shim, which runs in MAIN, so the tap heard nothing and the run looked like "the extension
//      sent nothing".
//
// Both are fixed here: the tap is installed in MAIN, and the press is a real mouse event. The run also
// waits for the button to be enabled before pressing, because pressing a disabled button does nothing
// and made an earlier run look like a successful handshake that never happened.
const path = require('node:path');

const { resolveBrowser } = require('../machine.cjs');
const { sleep, httpJson, cdp, launch, killProfile } = require('../browser-harness.cjs');

const BROWSER = resolveBrowser();
const PORT = 9404;
const EXT = path.join(__dirname, '..', '..');
const SITE = 'https://matrix.tencent.com/ai-detect/';

const workerUrl = targets => targets.find(t => String(t.url).includes('/src/background/index.js'));

(async () => {
    const session = await launch({
        browser: BROWSER,
        port: PORT,
        prefix: 'zqclean',
        args: [
            `--load-extension=${EXT}`,
            `--disable-extensions-except=${EXT}`,
            '--no-first-run',
            '--window-size=1280,900'
        ],
        url: SITE
    });

    await sleep(9000);

    const targets = await httpJson(PORT, '/json/list');
    const page = targets.find(t => t.type === 'page' && String(t.url).includes('matrix.tencent.com'));
    const worker = workerUrl(targets);
    if (!page || !worker) {
        console.log('missing target');
        await session.cleanup();
        return;
    }

    const pageClient = await cdp(page.webSocketDebuggerUrl);
    const workerClient = await cdp(worker.webSocketDebuggerUrl);

    const runIn = async (world, fnBody) => {
        const result = await workerClient.send('Runtime.evaluate', {
            expression: `(async () => {
                const tabs = await chrome.tabs.query({ url: 'https://matrix.tencent.com/*' });
                if (!tabs.length) return null;
                const res = await chrome.scripting.executeScript({
                    target: { tabId: tabs[0].id }, world: '${world}', func: ${fnBody}
                });
                return res[0].result;
            })()`,
            awaitPromise: true,
            returnByValue: true
        });
        return result.result.value;
    };

    // Tap in MAIN, where the shim dispatches.
    await runIn('MAIN', `() => {
        window.__frames = [];
        const note = (k, t) => window.__frames.push({ k, at: Date.now(), t: String(t).slice(0, 700) });
        window.addEventListener('zq:relay-sent', e => note('sent', e.detail));
        window.addEventListener('zq:relay-frame', e => note('frame', e.detail));
        window.addEventListener('zq:quick-pass', e => note('qp', JSON.stringify(e.detail && { len: e.detail.ticketLength })));
        window.addEventListener('zq:relay-failed', () => note('failed', ''));
    }`);

    // Wait for an enabled button: a disabled one swallows the press and the run looks like nothing
    // happened at all.
    let geo = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
        geo = await pageClient.send('Runtime.evaluate', {
            expression: `(() => {
                const b = Array.from(document.querySelectorAll('button'))
                    .find(x => (x.textContent || '').includes('立即检测'));
                if (!b) return { missing: true };
                if (b.disabled) return { disabled: true, text: b.textContent.trim() };
                b.scrollIntoView({ block: 'center' });
                const r = b.getBoundingClientRect();
                return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: b.textContent.trim(), disabled: false };
            })()`,
            returnByValue: true
        }).then(r => r.result.value);

        if (geo && !geo.disabled && !geo.missing) break;
        await sleep(1000);
    }

    console.log('button: ' + JSON.stringify(geo));
    if (!geo || geo.disabled || geo.missing) {
        console.log('button never became pressable');
        await sleep(500);
        await session.cleanup();
        return;
    }

    const stateBefore = await runIn('ISOLATED',
        `() => JSON.stringify({
            state: window.__zq && window.__zq.pageState ? window.__zq.pageState() : null,
            captchaOpen: window.__zq && window.__zq.captchaOpen ? window.__zq.captchaOpen() : null,
            uses: window.__zq && window.__zq.identityUses ? window.__zq.identityUses() : null
        })`);
    console.log('before: ' + stateBefore);

    await pageClient.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geo.x, y: geo.y, button: 'none', clickCount: 0 });
    await sleep(150);
    await pageClient.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.x, y: geo.y, button: 'left', clickCount: 1 });
    await sleep(80);
    await pageClient.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.x, y: geo.y, button: 'left', clickCount: 1 });
    console.log('pressed for real');

    for (let tick = 0; tick < 40; tick += 1) await sleep(500);

    const frames = JSON.parse(await runIn('MAIN', '() => JSON.stringify(window.__frames || [])') || '[]');
    const stateAfter = await runIn('ISOLATED',
        `() => JSON.stringify({
            state: window.__zq && window.__zq.pageState ? window.__zq.pageState() : null,
            captchaOpen: window.__zq && window.__zq.captchaOpen ? window.__zq.captchaOpen() : null,
            uses: window.__zq && window.__zq.identityUses ? window.__zq.identityUses() : null
        })`);

    console.log('');
    console.log('=== frames (' + frames.length + ') ===');
    const base = frames.length ? frames[0].at : 0;
    for (const item of frames) {
        let shown = item.t;
        const match = shown.match(/"ticket":"([^"]*)"/);
        if (match) shown = shown.replace(match[0], `"ticket":"<len ${match[1].length}>"`);
        console.log('+' + ((item.at - base) / 1000).toFixed(2) + 's  ' + item.k.padEnd(6) + shown.slice(0, 320));
    }
    console.log('');
    console.log('after: ' + stateAfter);

    pageClient.close();
    workerClient.close();
    await sleep(500);
    await session.cleanup();
})().catch(async error => {
    console.log('failed: ' + (error && error.message));
    process.exitCode = 1;
});
