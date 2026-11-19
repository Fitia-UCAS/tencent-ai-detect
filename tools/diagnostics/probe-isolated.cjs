// Measures a press inside the world the extension actually runs in.
//
// Every earlier capture read `window.__zq` from the debugger's default context and concluded the
// content script was absent. It was not: `chrome.scripting.executeScript` shows the split plainly.
//
//     ISOLATED world: ready true,  __zq true,  __zqRelayShim false   <- content scripts
//     MAIN world:     ready false, __zq false, __zqRelayShim true    <- the shim
//
// So the events the content script dispatches (`zq:relay-sent`, `zq:quick-pass`) live in the isolated
// world and are invisible from a main-world listener. This runs the tap through the extension's own
// scripting API, in the same world, which is the only place those events can be heard.
//
// Read-only: one real mouse press, dispatched through the input domain so the page receives it as
// trusted.
const path = require('node:path');

const { resolveBrowser } = require('../machine.cjs');
const { sleep, httpJson, cdp, launch, killProfile } = require('../browser-harness.cjs');

const BROWSER = resolveBrowser();
const PORT = 9402;
const EXT = path.join(__dirname, '..', '..');
const SITE = 'https://matrix.tencent.com/ai-detect/';

function backgroundTarget(targets) {
    // The worker, not the generated background pages of the browser's own components.
    return targets.find(t => String(t.url).includes('/src/background/index.js')) ||
        targets.find(t => t.type === 'service_worker' && String(t.url).includes('kdjgfock'));
}

(async () => {
    const session = await launch({
        browser: BROWSER,
        port: PORT,
        prefix: 'zqiso',
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
    const worker = backgroundTarget(targets);

    if (!page || !worker) {
        console.log('missing page or worker target');
        await session.cleanup();
        return;
    }

    const pageClient = await cdp(page.webSocketDebuggerUrl);
    const workerClient = await cdp(worker.webSocketDebuggerUrl);

    // Install the tap from inside the isolated world, where the content script's events are heard.
    const armed = await workerClient.send('Runtime.evaluate', {
        expression: `(async () => {
            const tabs = await chrome.tabs.query({ url: 'https://matrix.tencent.com/*' });
            if (!tabs.length) return 'no tab';
            const tabId = tabs[0].id;
            await chrome.scripting.executeScript({
                target: { tabId },
                world: 'ISOLATED',
                func: () => {
                    window.__zqFrames = [];
                    const note = (kind, text) => window.__zqFrames.push({ kind, at: Date.now(), text: String(text).slice(0, 700) });
                    window.addEventListener('zq:relay-sent', e => note('sent', e.detail));
                    window.addEventListener('zq:relay-frame', e => note('frame', e.detail));
                    window.addEventListener('zq:quick-pass', e => note('quick-pass', JSON.stringify(e.detail && { len: e.detail.ticketLength })));
                }
            });
            return 'armed on ' + tabId;
        })()`,
        awaitPromise: true,
        returnByValue: true
    });
    console.log(armed.result.value);

    // Where the button is, and what the content script thinks the page state is.
    const geo = await pageClient.send('Runtime.evaluate', {
        expression: `(() => {
            const b = Array.from(document.querySelectorAll('button'))
                .find(x => (x.textContent || '').includes('立即检测'));
            if (!b) return null;
            b.scrollIntoView({ block: 'center' });
            const r = b.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled, text: b.textContent.trim() };
        })()`,
        returnByValue: true
    });
    console.log('button: ' + JSON.stringify(geo.result.value));

    const stateBefore = await workerClient.send('Runtime.evaluate', {
        expression: `(async () => {
            const tabs = await chrome.tabs.query({ url: 'https://matrix.tencent.com/*' });
            const res = await chrome.scripting.executeScript({
                target: { tabId: tabs[0].id }, world: 'ISOLATED',
                func: () => JSON.stringify({
                    state: window.__zq && window.__zq.pageState ? window.__zq.pageState() : null,
                    captchaOpen: window.__zq && window.__zq.captchaOpen ? window.__zq.captchaOpen() : null
                })
            });
            return res[0].result;
        })()`,
        awaitPromise: true,
        returnByValue: true
    });
    console.log('state before press: ' + stateBefore.result.value);

    // A real press.
    await pageClient.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geo.result.value.x, y: geo.result.value.y, button: 'none', clickCount: 0 });
    await sleep(150);
    await pageClient.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.result.value.x, y: geo.result.value.y, button: 'left', clickCount: 1 });
    await sleep(80);
    await pageClient.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.result.value.x, y: geo.result.value.y, button: 'left', clickCount: 1 });
    console.log('pressed');

    for (let tick = 0; tick < 30; tick += 1) await sleep(500);

    const frames = await workerClient.send('Runtime.evaluate', {
        expression: `(async () => {
            const tabs = await chrome.tabs.query({ url: 'https://matrix.tencent.com/*' });
            const res = await chrome.scripting.executeScript({
                target: { tabId: tabs[0].id }, world: 'ISOLATED',
                func: () => JSON.stringify({
                    frames: window.__zqFrames || [],
                    state: window.__zq && window.__zq.pageState ? window.__zq.pageState() : null,
                    captchaOpen: window.__zq && window.__zq.captchaOpen ? window.__zq.captchaOpen() : null
                })
            });
            return res[0].result;
        })()`,
        awaitPromise: true,
        returnByValue: true
    });

    const parsed = JSON.parse(frames.result.value || '{}');
    console.log('');
    console.log('frames: ' + (parsed.frames || []).length);
    const base = parsed.frames && parsed.frames.length ? parsed.frames[0].at : Date.now();
    for (const item of parsed.frames || []) {
        const rel = ((item.at - base) / 1000).toFixed(2);
        let shown = item.text;
        const match = shown.match(/"ticket":"([^"]*)"/);
        if (match) shown = shown.replace(match[0], `"ticket":"<len ${match[1].length}>"`);
        console.log('+' + rel + 's  ' + item.kind.padEnd(11) + shown.slice(0, 300));
    }
    console.log('');
    console.log('state after: ' + JSON.stringify({ state: parsed.state, captchaOpen: parsed.captchaOpen }));

    pageClient.close();
    workerClient.close();
    await sleep(500);
    await session.cleanup();
})().catch(async error => {
    console.log('failed: ' + (error && error.message));
    process.exitCode = 1;
});
