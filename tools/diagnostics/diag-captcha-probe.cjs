// Inspects the Tencent captcha widget and captures its image for solving.
//
// The slider lives in a cross-origin iframe, so it cannot be scripted from the
// page side, but CDP input events are dispatched in page coordinates and do reach
// it. This records the widget's geometry and whether the puzzle image is reachable.
const path = require('node:path');
const fs = require('node:fs');

const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9382;
const SITE = 'https://matrix.tencent.com/ai-detect/';
const EXT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, '..', '..', 'tmp-diag');

const { sleep, httpJson, cdp, launch } = require('../browser-harness.cjs');

(async () => {
    const session = await launch({
        browser: BROWSER,
        port: PORT,
        prefix: 'zqcap',
        args: [`--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`]
    });

    try {
        const target = await httpJson(PORT, '/json/new?about:blank', 'PUT');
        const page = await cdp(target.webSocketDebuggerUrl);

        await page.send('Page.enable');
        await page.send('Runtime.enable');
        await page.send('Page.navigate', { url: SITE });

        // Wait for the app, clear the example, type, submit.
        for (let i = 0; i < 20; i++) {
            await sleep(2000);
            const ok = await page.send('Runtime.evaluate', {
                expression: `document.querySelectorAll('button').length > 5`,
                returnByValue: true
            });
            if (ok.result.value) break;
        }

        const click = async label => {
            const spot = await page.send('Runtime.evaluate', {
                expression: `(() => {
                    // The label carries a live counter ("立即检测(今日剩余5次)"), so
                    // an exact match misses it. Match on contains, and prefer the
                    // shortest match so a container does not win over the button.
                    const hits = [...document.querySelectorAll('button')]
                        .filter(x => (x.innerText || '').includes(${JSON.stringify(label)}))
                        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
                    const b = hits[0];
                    if (!b) return null;
                    const r = b.getBoundingClientRect();
                    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
                })()`,
                returnByValue: true
            });
            if (!spot.result.value) return false;
            const { x, y } = JSON.parse(spot.result.value);
            await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
            await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
            return true;
        };

        // Close the "重要声明" notice if it is covering the page.
        await page.send('Runtime.evaluate', {
            expression: `(() => {
                const x = document.querySelector('.el-notification__closeBtn, .el-message-box__close');
                if (x) { x.click(); return 'closed'; }
                return 'none';
            })()`,
            returnByValue: true
        });

        for (let attempt = 0; attempt < 5; attempt++) {
            await click('清空');
            for (let i = 0; i < 6; i++) {
                await sleep(500);
                const has = await page.send('Runtime.evaluate', {
                    expression: `!!document.querySelector('textarea.el-textarea__inner')`,
                    returnByValue: true
                });
                if (has.result.value) break;
            }
            const check = await page.send('Runtime.evaluate', {
                expression: `!!document.querySelector('textarea.el-textarea__inner')`,
                returnByValue: true
            });
            if (check.result.value) break;
        }

        const text = '我与父亲不相见已二年余了，我最不能忘记的是他的背影。那年冬天，祖母死了，父亲的差使也交卸了，正是祸不单行的日子。'
            + '我从北京到徐州，打算跟着父亲奔丧回家。到徐州见着父亲，看见满院狼藉的东西，又想起祖母，不禁簌簌地流下眼泪。'
            + '父亲说，事已如此，不必难过，好在天无绝人之路。回家变卖典质，父亲还了亏空；又借钱办了丧事。'
            + '这些日子，家中光景很是惨淡，一半为了丧事，一半为了父亲赋闲。丧事完毕，父亲要到南京谋事，我也要回北京念书，我们便同行。';

        await page.send('Runtime.evaluate', {
            expression: `(() => {
                const box = document.querySelector('textarea.el-textarea__inner');
                if (!box) return 'none';
                const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
                setter.call(box, ${JSON.stringify(text)});
                box.dispatchEvent(new Event('input', { bubbles: true }));
                return box.value.length;
            })()`,
            returnByValue: true
        });

        await sleep(800);
        await click('立即检测');
        await sleep(5000);

        // Geometry of the captcha container and its iframe.
        const geometry = await page.send('Runtime.evaluate', {
            expression: `(() => {
                const out = [];
                for (const sel of ['#tcaptcha_iframe_dy', '#tcaptcha_wrapper_transform_dy', '.tcaptcha-transform']) {
                    const n = document.querySelector(sel);
                    if (!n) continue;
                    const r = n.getBoundingClientRect();
                    out.push(sel + ' -> x=' + Math.round(r.x) + ' y=' + Math.round(r.y)
                        + ' w=' + Math.round(r.width) + ' h=' + Math.round(r.height));
                }
                return out.join('\\n') || '(captcha not present)';
            })()`,
            returnByValue: true
        });

        process.stdout.write(geometry.result.value + '\n');

        const metrics = await page.send('Page.getLayoutMetrics');
        process.stdout.write(`viewport: ${Math.round(metrics.cssLayoutViewport.clientWidth)}x${Math.round(metrics.cssLayoutViewport.clientHeight)}\n`);

        const png = await page.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(OUT, 'captcha-widget.png'), Buffer.from(png.data, 'base64'));
        process.stdout.write(`screenshot: ${path.join(OUT, 'captcha-widget.png')}\n`);

        await sleep(2000);
    } finally {
        await session.cleanup();
    }
})();
