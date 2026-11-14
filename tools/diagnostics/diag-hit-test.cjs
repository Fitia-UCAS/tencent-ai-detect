// Identifies the element under the text box by hit-testing, not by selectors.
//
// Scanning for textarea / contenteditable finds nothing even after the page has
// fully rendered, yet a large editable box is plainly on screen. Waiting on the
// right selector has been a dead end, so this asks the browser which element is
// actually at that point and walks up its ancestry.
const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9385;
const SITE = 'https://matrix.tencent.com/ai-detect/';
const OUT = require('node:path').join(__dirname, '..', 'tmp-diag');

const { sleep, httpJson, cdp, launch } = require('../browser-harness.cjs');

(async () => {
    const session = await launch({ browser: BROWSER, port: PORT, prefix: 'zqhit' });

    try {
        const target = await httpJson(PORT, '/json/new?about:blank', 'PUT');
        const page = await cdp(target.webSocketDebuggerUrl);

        await page.send('Page.enable');
        await page.send('Runtime.enable');
        await page.send('Page.navigate', { url: SITE });
        await sleep(18000);

        const hit = await page.send('Runtime.evaluate', {
            expression: `(() => {
                const describe = n => {
                    if (!n) return 'null';
                    const cls = String(n.getAttribute('class') || '');
                    const r = n.getBoundingClientRect();
                    return n.tagName.toLowerCase()
                        + (cls ? '.' + cls.split(/\\s+/).slice(0, 2).join('.') : '')
                        + (n.id ? '#' + n.id : '')
                        + '[ce=' + (n.getAttribute('contenteditable') || '-') + ']'
                        + (n.isContentEditable ? '{EDITABLE}' : '')
                        + ' ' + Math.round(r.width) + 'x' + Math.round(r.height);
                };

                const points = [[400, 350], [400, 500], [400, 650], [200, 400]];
                const out = [];

                for (const [x, y] of points) {
                    const el = document.elementFromPoint(x, y);
                    const chain = [];
                    let n = el;
                    for (let i = 0; i < 5 && n; i++, n = n.parentElement) chain.push(describe(n));
                    out.push({ point: x + ',' + y, chain });
                }

                return JSON.stringify(out, null, 1);
            })()`,
            returnByValue: true
        });

        process.stdout.write(hit.result.value + '\n');

        // Whether focusing that region turns anything editable.
        await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 400, y: 400, button: 'left', clickCount: 1 });
        await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 400, y: 400, button: 'left', clickCount: 1 });
        await sleep(800);

        const afterClick = await page.send('Runtime.evaluate', {
            expression: `JSON.stringify({
                active: document.activeElement ? document.activeElement.tagName.toLowerCase() + '.' + String(document.activeElement.className||'').slice(0,40) : null,
                activeEditable: document.activeElement ? document.activeElement.isContentEditable : null,
                ceCount: document.querySelectorAll('[contenteditable]').length,
                taCount: document.querySelectorAll('textarea').length
            })`,
            returnByValue: true
        });

        process.stdout.write('after click: ' + afterClick.result.value + '\n');

        const png = await page.send('Page.captureScreenshot', { format: 'png' });
        require('node:fs').writeFileSync(OUT + '/hit-test.png', Buffer.from(png.data, 'base64'));
        process.stdout.write('screenshot: ' + OUT + '/hit-test.png\n');
    } finally {
        await session.cleanup();
    }
})();
