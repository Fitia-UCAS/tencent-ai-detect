// Clears the pre-loaded example, which is what reveals the real input.
//
// The text area is not a textarea at all while an example is loaded: it is a
// rendered segment view (span.txt-segmentType-*) with no editable element, which
// is why every query for textarea / contenteditable came back empty. The page
// swaps in the actual input once the example is cleared.
const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9384;
const SITE = 'https://matrix.tencent.com/ai-detect/';
const OUT = require('node:path').join(__dirname, '..', 'tmp-diag');

const { sleep, httpJson, cdp, launch } = require('../browser-harness.cjs');

(async () => {
    const session = await launch({ browser: BROWSER, port: PORT, prefix: 'zqclear' });

    try {
        const target = await httpJson(PORT, '/json/new?about:blank', 'PUT');
        const page = await cdp(target.webSocketDebuggerUrl);

        await page.send('Page.enable');
        await page.send('Runtime.enable');
        await page.send('Page.navigate', { url: SITE });
        await sleep(18000);

        const probe = () => page.send('Runtime.evaluate', {
            expression: `JSON.stringify({
                textareas: [...document.querySelectorAll('textarea')].map(t => t.className + ':' + t.offsetParent !== null),
                ce: document.querySelectorAll('[contenteditable]').length,
                segmentBox: document.querySelectorAll('.txt-segment-box').length
            })`,
            returnByValue: true
        });

        process.stdout.write('before clear: ' + (await probe()).result.value + '\n');

        // Click the clear control the way a user would: a trusted hit on its centre.
        const spot = await page.send('Runtime.evaluate', {
            expression: `(() => {
                const b = [...document.querySelectorAll('button')].find(x => (x.innerText || '').trim() === '清空');
                if (!b) return null;
                const r = b.getBoundingClientRect();
                return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
            })()`,
            returnByValue: true
        });

        if (!spot.result.value) {
            process.stdout.write('clear button not found\n');
            return;
        }

        const { x, y } = JSON.parse(spot.result.value);
        await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        process.stdout.write(`clicked clear at ${x},${y}\n`);
        await sleep(2000);

        process.stdout.write('after clear : ' + (await probe()).result.value + '\n');

        // Report what became editable, if anything.
        const detail = await page.send('Runtime.evaluate', {
            expression: `(() => {
                const out = [];
                for (const n of document.querySelectorAll('textarea, [contenteditable], input')) {
                    const r = n.getBoundingClientRect();
                    out.push(n.tagName.toLowerCase() + '.' + String(n.getAttribute('class')||'').slice(0,40)
                        + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)
                        + ' ce=' + (n.getAttribute('contenteditable') || '-'));
                }
                return out.join('\\n') || '(nothing editable)';
            })()`,
            returnByValue: true
        });

        process.stdout.write(detail.result.value + '\n');

        const png = await page.send('Page.captureScreenshot', { format: 'png' });
        require('node:fs').writeFileSync(OUT + '/after-clear.png', Buffer.from(png.data, 'base64'));
        process.stdout.write('screenshot: ' + OUT + '/after-clear.png\n');
    } finally {
        await session.cleanup();
    }
})();
