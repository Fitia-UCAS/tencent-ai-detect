// Does the extension change how many times the captcha re-asks for its own template?
//
// The claim under test is "已更换题目 is the captcha's own placeholder swap, not something this
// extension causes". That cannot be settled by reading the extension's trail, because the swap happens
// inside a cross-origin iframe the extension never touches. It needs a control: the same press, same
// site, with and without the extension loaded, counting how many times the captcha fetches its own
// prehandle template.
//
// The counter is the captcha service's own `cap_union_prehandle` call. One press reasonably needs one;
// a second call in the same press is the widget replacing its own question, which is the thing the
// user sees as "已更换题目".
//
// Requests are collected from every frame, not just the top one: the captcha lives in an iframe served
// from captcha.gtimg.com, and a listener attached to the page session alone would never see it.
const path = require('node:path');

const { resolveBrowser } = require('../machine.cjs');
const { sleep, httpJson, cdp, launch, killProfile } = require('../browser-harness.cjs');

const BROWSER = resolveBrowser();
const EXT = path.join(__dirname, '..', '..');
const SITE = 'https://matrix.tencent.com/ai-detect/';

function isCaptchaRequest(url) {
    return url.includes('cap_union_prehandle') || url.includes('cap_union_new_show');
}

// One run: open the site, press the detect button once for real, count captcha traffic for a while.
async function run({ withExtension, port, prefix }) {
    const args = ['--no-first-run', '--window-size=1280,900'];
    if (withExtension) {
        args.push(`--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`);
    }

    const session = await launch({ browser: BROWSER, port, prefix, args, url: SITE });
    await sleep(9000);

    const targets = await httpJson(port, '/json/list');
    const page = targets.find(t => t.type === 'page' && String(t.url).includes('matrix.tencent.com'));
    if (!page) {
        await session.cleanup();
        return { label: withExtension ? 'with extension' : 'without extension', error: 'no page' };
    }

    const client = await cdp(page.webSocketDebuggerUrl);
    const seen = [];

    // Child frames report on their own sessions, so every session gets Network enabled and its own
    // listener. Without this the captcha iframe is invisible.
    client.on(msg => {
        if (msg.method === 'Target.attachedToTarget') {
            const childSession = msg.params.sessionId;
            client.send('Network.enable', {}, childSession).catch(() => {});
            return;
        }

        if (msg.method === 'Network.requestWillBeSent') {
            const url = msg.params.request.url;
            if (isCaptchaRequest(url)) {
                seen.push({ at: Date.now(), url: url.split('?')[0], full: url });
            }
        }
    });

    await client.send('Target.setAutoAttach', {
        autoAttach: true, waitForDebuggerOnStart: false, flatten: true
    }).catch(() => {});
    await client.send('Network.enable');

    await sleep(2000);

    // Wait for a pressable button, then press it for real.
    let geo = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
        geo = await client.send('Runtime.evaluate', {
            expression: `(() => {
                const b = Array.from(document.querySelectorAll('button'))
                    .find(x => (x.textContent || '').includes('立即检测'));
                if (!b) return { missing: true };
                if (b.disabled) return { disabled: true };
                b.scrollIntoView({ block: 'center' });
                const r = b.getBoundingClientRect();
                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            })()`,
            returnByValue: true
        }).then(r => r.result.value);

        if (geo && geo.x) break;
        await sleep(1000);
    }

    if (!geo || !geo.x) {
        client.close();
        await session.cleanup();
        return { label: withExtension ? 'with extension' : 'without extension', error: 'no button' };
    }

    const beforePress = seen.length;

    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geo.x, y: geo.y, button: 'none', clickCount: 0 });
    await sleep(150);
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.x, y: geo.y, button: 'left', clickCount: 1 });
    await sleep(80);
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.x, y: geo.y, button: 'left', clickCount: 1 });

    // Long enough to cover the placeholder swap and a replacement.
    await sleep(22000);

    const during = seen.slice(beforePress);

    // Was the widget actually on screen at the end? A run where no widget appeared proves nothing.
    const widget = await client.send('Runtime.evaluate', {
        expression: `(() => {
            const el = document.getElementById('tcaptcha_wrapper_transform_dy') ||
                document.getElementById('tcaptcha_iframe_dy');
            if (!el) return { present: false };
            const r = el.getBoundingClientRect();
            return {
                present: true,
                y: Math.round(r.y),
                visible: r.top < window.innerHeight && r.bottom > 0 && r.width > 0,
                text: String(document.body.innerText || '').includes('已更换题目')
            };
        })()`,
        returnByValue: true
    });

    client.close();
    await sleep(400);
    await session.cleanup();

    return {
        label: withExtension ? 'with extension' : 'without extension',
        pressCount: during.length,
        urls: during.map(item => item.url.replace('https://', '')),
        bodySaysChanged: widget.result.value ? widget.result.value.text : null,
        widgetVisible: widget.result.value ? widget.result.value.visible : null
    };
}

(async () => {
    const results = [];
    results.push(await run({ withExtension: false, port: 9410, prefix: 'zqctl-noext' }));
    results.push(await run({ withExtension: true, port: 9411, prefix: 'zqctl-ext' }));

    console.log('');
    console.log('=== one press, captcha traffic counted ===');
    for (const result of results) {
        console.log('');
        console.log(result.label);
        if (result.error) {
            console.log('  could not run: ' + result.error);
            continue;
        }
        console.log('  captcha requests after the press: ' + result.pressCount);
        for (const url of result.urls) console.log('    ' + url);
        console.log('  widget on screen at the end: ' + result.widgetVisible);
        console.log('  page says 已更换题目: ' + result.bodySaysChanged);
    }

    console.log('');
    const [withoutExt, withExt] = results;
    if (withoutExt.error || withExt.error) {
        console.log('a run failed; no comparison');
        return;
    }

    if (withoutExt.pressCount === withExt.pressCount) {
        console.log('Same count both ways: the re-ask is the captcha\'s own behaviour, not the extension\'s.');
    } else {
        console.log('Different counts: the extension changes how the captcha behaves.');
        console.log('  without: ' + withoutExt.pressCount + '   with: ' + withExt.pressCount);
    }
})().catch(error => {
    console.log('failed: ' + (error && error.message));
});
