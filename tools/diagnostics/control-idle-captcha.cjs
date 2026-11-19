// Does the widget re-ask for its template without anyone pressing anything?
//
// The previous control showed one press costs two `cap_union_prehandle` calls whether or not the
// extension is loaded, so the second call is the widget's own. What that control could not answer is
// the question that actually matters: does it happen with no press at all?
//
// This watches the site untouched, from load to 40 seconds, and reports every captcha request with the
// time it happened. A press is never made. If the widget asks twice here too, the re-ask is simply how
// it initialises; if it asks once, the second call is tied to the press and the swap the user sees
// belongs to the press, not to idle time.
const path = require('node:path');

const { resolveBrowser } = require('../machine.cjs');
const { sleep, httpJson, cdp, launch, killProfile } = require('../browser-harness.cjs');

const BROWSER = resolveBrowser();
const EXT = path.join(__dirname, '..', '..');
const SITE = 'https://matrix.tencent.com/ai-detect/';

const isCaptcha = url => url.includes('cap_union') || url.includes('captcha.gtimg.com');

async function watch({ withExtension, port, prefix, seconds }) {
    const args = ['--no-first-run', '--window-size=1280,900'];
    if (withExtension) args.push(`--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`);

    const session = await launch({ browser: BROWSER, port, prefix, args, url: SITE });
    await sleep(6000);

    const targets = await httpJson(port, '/json/list');
    const page = targets.find(t => t.type === 'page' && String(t.url).includes('matrix.tencent.com'));
    if (!page) {
        await session.cleanup();
        return { label: withExtension ? 'with extension' : 'without extension', error: 'no page' };
    }

    const client = await cdp(page.webSocketDebuggerUrl);
    const seen = [];

    client.on(msg => {
        if (msg.method === 'Target.attachedToTarget') {
            client.send('Network.enable', {}, msg.params.sessionId).catch(() => {});
            return;
        }
        if (msg.method === 'Network.requestWillBeSent') {
            const url = msg.params.request.url;
            if (isCaptcha(url)) seen.push({ at: Date.now(), url });
        }
    });

    await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
    await client.send('Network.enable');

    const startedAt = Date.now();

    // No press. Only watch.
    for (let tick = 0; tick < seconds * 2; tick += 1) await sleep(500);

    const widget = await client.send('Runtime.evaluate', {
        expression: `(() => {
            const el = document.getElementById('tcaptcha_wrapper_transform_dy');
            if (!el) return { present: false };
            const r = el.getBoundingClientRect();
            return {
                present: true,
                y: Math.round(r.y),
                visible: r.top < window.innerHeight && r.bottom > 0 && r.width > 0,
                saysChanged: String(document.body.innerText || '').includes('已更换题目')
            };
        })()`,
        returnByValue: true
    });

    client.close();
    await sleep(400);
    await session.cleanup();

    return {
        label: withExtension ? 'with extension' : 'without extension',
        count: seen.length,
        timeline: seen.map(item => ({
            afterLoad: ((item.at - startedAt) / 1000).toFixed(1) + 's',
            url: item.url.split('?')[0].replace('https://', '')
        })),
        widget: widget.result.value
    };
}

(async () => {
    const results = [];
    results.push(await watch({ withExtension: false, port: 9412, prefix: 'zqidle-noext', seconds: 40 }));
    results.push(await watch({ withExtension: true, port: 9413, prefix: 'zqidle-ext', seconds: 40 }));

    console.log('');
    console.log('=== 40 seconds, no press at all ===');
    for (const result of results) {
        console.log('');
        console.log(result.label);
        if (result.error) {
            console.log('  could not run: ' + result.error);
            continue;
        }
        console.log('  captcha requests: ' + result.count);
        for (const item of result.timeline) console.log('    +' + item.afterLoad + '  ' + item.url);
        console.log('  widget: ' + JSON.stringify(result.widget));
    }
})().catch(error => {
    console.log('failed: ' + (error && error.message));
});
