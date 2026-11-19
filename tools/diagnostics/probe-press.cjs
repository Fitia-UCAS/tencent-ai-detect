// Diagnoses why a real press produced no frames.
//
// Measured: `Input.dispatchMouseEvent` reached the page with `isTrusted: true`, the button was enabled
// and inside the viewport, and the extension dispatched nothing at all - no `zq:relay-sent`, no
// `zq:relay-frame`, not even a `press-blocked`. A synthetic `element.click()` in an earlier run did
// produce a frame, so the difference is not the button or the site.
//
// The suspicion is that the content script saw the press and dropped it, or never saw it. This answers
// which, by arming a capture listener alongside the extension's own and reading back both.
const path = require('node:path');

const { resolveBrowser } = require('../machine.cjs');
const { sleep, httpJson, cdp, launch, killProfile } = require('../browser-harness.cjs');

const BROWSER = resolveBrowser();
const PORT = 9396;
const MATRIX = 'https://matrix.tencent.com/ai-detect/';
const EXT = path.join(__dirname, '..', '..');

(async () => {
    const session = await launch({
        browser: BROWSER,
        port: PORT,
        prefix: 'zqprobe',
        args: [
            `--load-extension=${EXT}`,
            `--disable-extensions-except=${EXT}`,
            '--no-first-run',
            '--window-size=1280,900'
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
    await sleep(8000);

    // Is the extension's content script alive in this page at all?
    const alive = await client.send('Runtime.evaluate', {
        expression: `(() => ({
            ready: !!window.__zqDetectReady,
            hasZq: !!window.__zq,
            hasTrace: !!(window.__zq && typeof window.__zq.trace === 'function'),
            state: window.__zq && window.__zq.state ? Object.keys(window.__zq.state).slice(0, 12) : null,
            xff: document.documentElement.getAttribute('data-zq-xff')
        }))()`,
        returnByValue: true
    });
    console.log('content script: ' + JSON.stringify(alive.result.value));

    // Watch both the extension's events and the raw click, then press for real.
    await client.send('Runtime.evaluate', {
        expression: `(() => {
            window.__zqCapture = [];
            window.__rawClicks = [];
            const note = (kind, text) => window.__zqCapture.push({ kind, at: Date.now(), text: String(text).slice(0, 600) });
            window.addEventListener('zq:relay-sent', e => note('sent', e.detail));
            window.addEventListener('zq:relay-frame', e => note('frame', e.detail));
            window.addEventListener('zq:quick-pass', e => note('quick-pass', JSON.stringify(e.detail)));
            document.addEventListener('click', e => {
                const t = e.target;
                window.__rawClicks.push({
                    tag: t && t.tagName,
                    cls: t && String(t.className || '').slice(0, 40),
                    text: t && String(t.textContent || '').trim().slice(0, 30),
                    trusted: e.isTrusted,
                    at: Date.now()
                });
            }, true);
            return 'armed';
        })()`,
        returnByValue: true
    });

    const geo = await client.send('Runtime.evaluate', {
        expression: `(() => {
            const b = Array.from(document.querySelectorAll('button'))
                .find(x => (x.textContent || '').includes('立即检测'));
            if (!b) return null;
            b.scrollIntoView({ block: 'center' });
            const r = b.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled };
        })()`,
        returnByValue: true
    });

    console.log('button: ' + JSON.stringify(geo.result.value));

    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geo.result.value.x, y: geo.result.value.y, button: 'none', clickCount: 0 });
    await sleep(150);
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.result.value.x, y: geo.result.value.y, button: 'left', clickCount: 1 });
    await sleep(80);
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.result.value.x, y: geo.result.value.y, button: 'left', clickCount: 1 });

    console.log('pressed for real');
    for (let tick = 0; tick < 24; tick += 1) await sleep(500);

    const result = await client.send('Runtime.evaluate', {
        expression: `JSON.stringify({
            clicks: window.__rawClicks,
            frames: window.__zqCapture,
            state: window.__zq && typeof window.__zq.pageState === 'function' ? window.__zq.pageState() : null,
            button: (Array.from(document.querySelectorAll('button')).find(x => (x.textContent||'').includes('立即检测')) || {}).textContent
        })`,
        returnByValue: true
    });

    const parsed = JSON.parse(result.result.value);
    console.log('');
    console.log('raw clicks the page saw:');
    for (const c of parsed.clicks) console.log('  ' + JSON.stringify(c));
    console.log('');
    console.log('frames the extension emitted: ' + parsed.frames.length);
    for (const f of parsed.frames) console.log('  ' + f.kind + ' ' + f.text.slice(0, 160));
    console.log('');
    console.log('page state now: ' + parsed.state);
    console.log('button now: ' + parsed.button);

    client.close();
    await sleep(500);
    await session.cleanup();
})().catch(async error => {
    console.log('failed: ' + (error && error.message));
    process.exitCode = 1;
});
