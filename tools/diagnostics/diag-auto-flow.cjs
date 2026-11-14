// Automated detection attempt up to the captcha, then a report on what the
// captcha needs.
//
// Two page details had to be discovered before this could work: the page takes
// ~15s to render its editor, and the text box does not exist while an example is
// loaded - it is a rendered segment view until the clear button is pressed, which is what makes
// the real textarea appear. Both were found by measuring, not by guessing.
const path = require('node:path');
const fs = require('node:fs');

const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9383;
const SITE = 'https://matrix.tencent.com/ai-detect/';
const OUT = path.join(__dirname, '..', '..', 'tmp-diag');

const { sleep, httpJson, cdp, launch } = require('../browser-harness.cjs');

const SAMPLE =
    '我与父亲不相见已二年余了，我最不能忘记的是他的背影。那年冬天，祖母死了，父亲的差使也交卸了，正是祸不单行的日子。' +
    '我从北京到徐州，打算跟着父亲奔丧回家。到徐州见着父亲，看见满院狼藉的东西，又想起祖母，不禁簌簌地流下眼泪。' +
    '父亲说，事已如此，不必难过，好在天无绝人之路。回家变卖典质，父亲还了亏空；又借钱办了丧事。' +
    '这些日子，家中光景很是惨淡，一半为了丧事，一半为了父亲赋闲。丧事完毕，父亲要到南京谋事，我也要回北京念书，我们便同行。' +
    '到南京时，有朋友约去游逛，勾留了一日；第二日上午便须渡江到浦口，下午上车北去。' +
    '父亲因为事忙，本已说定不送我，叫旅馆里一个熟识的茶房陪我同去。他再三嘱咐茶房，甚是仔细。' +
    '但他终于不放心，怕茶房不妥帖；颇踌躇了一会。其实我那年已二十岁，北京已来往过两三次，是没有什么要紧的了。' +
    '他踌躇了一会，终于决定还是自己送我去。我再三劝他不必去；他只说，不要紧，他们去不好。';

async function clickText(page, label) {
    const spot = await page.send('Runtime.evaluate', {
        expression: `(() => {
            const b = [...document.querySelectorAll('button')].find(x => (x.innerText || '').trim() === ${JSON.stringify(label)});
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
}

(async () => {
    const session = await launch({
        browser: BROWSER,
        port: PORT,
        prefix: 'zqauto2',
        // The extension supplies the shim that reroutes the socket to the relay.
        // Without it the page opens a direct socket and the run proves nothing
        // about the relay path.
        args: [`--load-extension=${path.join(__dirname, '..', '..')}`, `--disable-extensions-except=${path.join(__dirname, '..', '..')}`]
    });

    try {
        const target = await httpJson(PORT, '/json/new?about:blank', 'PUT');
        const page = await cdp(target.webSocketDebuggerUrl);

        await page.send('Page.enable');
        await page.send('Runtime.enable');
        await page.send('Network.enable');

        const sockIds = new Map();
        let sockSeq = 0;

        page.on(msg => {
            const p = msg.params;

            if (msg.method === 'Network.webSocketCreated') {
                if (!/9420|getClassify/.test(p.url)) return;
                sockIds.set(p.requestId, ++sockSeq);
                process.stdout.write(`  ws#${sockSeq} CREATED ${p.url}\n`);
            }

            const id = sockIds.get(p.requestId);

            if (msg.method === 'Network.webSocketFrameSent' && id) {
                process.stdout.write(`  ws#${id} SEND ${String(p.response.payloadData).slice(0, 100)}\n`);
            }
            if (msg.method === 'Network.webSocketFrameReceived' && id) {
                process.stdout.write(`  ws#${id} RECV ${String(p.response.payloadData).slice(0, 160)}\n`);
            }
            if (msg.method === 'Network.webSocketClosed' && id) {
                process.stdout.write(`  ws#${id} CLOSED\n`);
            }
            if (msg.method === 'Runtime.exceptionThrown') {
                process.stdout.write(`  EXCEPTION ${p.exceptionDetails.text}\n`);
            }
        });

        await page.send('Page.navigate', { url: SITE });

        // The editor only exists after the app has rendered.
        let ready = false;
        for (let i = 0; i < 20 && !ready; i++) {
            await sleep(2000);
            const probe = await page.send('Runtime.evaluate', {
                expression: `document.querySelectorAll('button').length > 5`,
                returnByValue: true
            });
            ready = probe.result.value === true;
        }

        process.stdout.write(`page ready: ${ready}\n`);

        // Clear the loaded example: this is what swaps the segment view for a real
        // textarea, and it is the step every earlier attempt was missing. The swap
        // is not instantaneous, so retry until the textarea actually exists.
        let cleared = false;
        for (let attempt = 0; attempt < 5 && !cleared; attempt++) {
            if (!await clickText(page, '清空')) {
                await sleep(1500);
                continue;
            }

            for (let i = 0; i < 6 && !cleared; i++) {
                await sleep(500);
                const probe = await page.send('Runtime.evaluate', {
                    expression: `!!document.querySelector('textarea.el-textarea__inner')`,
                    returnByValue: true
                });
                cleared = probe.result.value === true;
            }
        }

        process.stdout.write(`cleared: ${cleared}\n`);

        if (!cleared) {
            process.stdout.write('the textarea never appeared; the example could not be cleared\n');
            return;
        }

        const typed = await page.send('Runtime.evaluate', {
            expression: `(() => {
                const box = document.querySelector('textarea.el-textarea__inner');
                if (!box) return 'no textarea';
                const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
                setter.call(box, ${JSON.stringify(SAMPLE)});
                box.dispatchEvent(new Event('input', { bubbles: true }));
                box.dispatchEvent(new Event('change', { bubbles: true }));
                return 'typed ' + box.value.length + ' chars';
            })()`,
            returnByValue: true
        });

        process.stdout.write(`type: ${typed.result.value}\n`);
        await sleep(1000);

        if (!await clickText(page, '立即检测')) {
            process.stdout.write('detect button not found\n');
            return;
        }

        process.stdout.write('clicked detect\n');
        await sleep(6000);

        // Report the captcha surface so the remaining manual step is explicit.
        const captcha = await page.send('Runtime.evaluate', {
            expression: `JSON.stringify({
                frames: [...document.querySelectorAll('iframe')].map(f => f.src).filter(Boolean),
                dialogs: [...document.querySelectorAll('[id*=captcha], [class*=captcha]')].map(n => n.id || n.className)
            })`,
            returnByValue: true
        });

        process.stdout.write(`captcha: ${captcha.result.value}\n`);

        const png = await page.send('Page.captureScreenshot', { format: 'png' });
        const file = path.join(OUT, 'auto-detect.png');
        fs.writeFileSync(file, Buffer.from(png.data, 'base64'));
        process.stdout.write(`screenshot: ${file}\n`);

        // Keep the window alive long enough for a human to finish the slider.
        process.stdout.write('\nThe window can be closed when done; waiting 90s to record frames after the challenge...\n');
        await sleep(90000);
    } finally {
        await session.cleanup();
    }
})();
