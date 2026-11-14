// Verifies the challenge check against a real browser document.
//
// test-captcha-guard proves the predicate's logic and that every reload path consults it, but it
// runs the function against a hand-made document object. Two failures would slip past that:
//
//   a miss   the real SDK container is not matched, so a reload still lands mid-challenge
//   a false  some always-present element is matched, so the page never reloads again - worse,
//            because it is silent and permanent
//
// This loads the shipped predicate into the real page and drives it with a container built to the
// structure observed on the live site.
const path = require('node:path');

const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.resolve(__dirname, '..');
const EXT_ID = process.env.EXT_ID || 'kdjgfockdecdbadmpbjgflmiffdiffhp';
const PORT = Number(process.env.GUARD_PORT || 9397);
const SITE = 'https://matrix.tencent.com/ai-detect/';

const { sleep, cdp, launch } = require('./browser-harness.cjs');

const content = require('node:fs').readFileSync(path.join(EXT, 'content.js'), 'utf8');
const start = content.indexOf('function captchaOpen()');
const end = content.indexOf('\n    }', start) + 6;
const captchaSource = content.slice(start, end);

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log('%s %s%s', ok ? 'ok  ' : 'FAIL', name, detail ? '  - ' + detail : '');
};

async function targets() {
    return (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
}

async function waitFor(match, timeoutMs = 25000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        try {
            const found = (await targets()).find(match);
            if (found) return found;
        } catch (error) {
            // Port not up yet.
        }
        await sleep(400);
    }
    return null;
}

const evaluate = async (conn, expression) => {
    const out = await conn.send('Runtime.evaluate', { expression, returnByValue: true });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.text);
    return out.result?.value;
};

// The predicate plus a harness that moves the real container through the states it takes.
const HARNESS = `(() => {
    const captchaOpen = (${captchaSource});

    const state = { idle: captchaOpen() };

    // The page ships this container already. Reuse it when present so the test exercises the
    // element the SDK actually uses, and build one only if it is missing.
    let wrapper = document.getElementById('tcaptcha_wrapper_transform_dy');
    let created = false;
    if (!wrapper) {
        wrapper = document.createElement('div');
        wrapper.id = 'tcaptcha_wrapper_transform_dy';
        document.body.appendChild(wrapper);
        created = true;
    }

    let frame = document.getElementById('tcaptcha_iframe_dy');
    if (!frame) {
        frame = document.createElement('iframe');
        frame.id = 'tcaptcha_iframe_dy';
        wrapper.appendChild(frame);
    }

    const saved = {
        wrapperStyle: wrapper.getAttribute('style') || '',
        frameStyle: frame.getAttribute('style') || ''
    };

    // 1. Show it the way the screenshot did: a 360x360 panel in the middle of the page.
    wrapper.style.cssText = 'position:fixed;top:50%;left:50%;width:360px;height:360px;' +
        'margin:-180px 0 0 -180px;opacity:1;z-index:99999';
    frame.style.cssText = 'width:360px;height:360px;border:0';
    state.onScreen = captchaOpen();

    // 2. Fade it out the way the SDK does while opening.
    wrapper.style.opacity = '0';
    state.transparent = captchaOpen();

    // 3. Park it off-screen the way the SDK does when idle - the state that broke the first version.
    wrapper.style.opacity = '1';
    wrapper.style.cssText = 'position:absolute;top:-1000000px;left:0;width:300px;height:155px;opacity:0';
    state.parked = captchaOpen();

    // Put everything back.
    if (created) {
        wrapper.remove();
    } else {
        wrapper.setAttribute('style', saved.wrapperStyle);
        frame.setAttribute('style', saved.frameStyle);
    }

    state.restored = captchaOpen();
    return state;
})()`;

(async () => {
    const session = await launch({
        browser: BROWSER,
        port: PORT,
        prefix: 'zqguard',
        args: [
            '--disable-features=DisableLoadExtensionCommandLineSwitch',
            `--disable-extensions-except=${EXT}`,
            `--load-extension=${EXT}`
        ]
    });

    let conn = null;

    try {
        const worker = await waitFor(t => t.type === 'service_worker' && (t.url || '').includes(EXT_ID));
        if (!worker) throw new Error('the service worker never started');

        // Opening the page through the worker occasionally does not land when another browser was
        // driven moments earlier - the tab request is accepted and then lost. Retry it rather than
        // failing the run on a timing artefact.
        let page = null;
        for (let attempt = 1; attempt <= 3 && !page; attempt++) {
            const wc = await cdp(worker.webSocketDebuggerUrl);
            try {
                await wc.send('Runtime.evaluate', {
                    expression: `chrome.tabs.create({ url: ${JSON.stringify(SITE)}, active: true })`,
                    awaitPromise: true
                });
            } catch (error) {
                // A worker that went to sleep is not a reason to fail; the next attempt reconnects.
            } finally {
                wc.close();
            }

            page = await waitFor(t => (t.url || '').includes('matrix.tencent.com'), 30000);
        }

        if (!page) throw new Error('the detection page never opened after 3 attempts');

        conn = await cdp(page.webSocketDebuggerUrl);
        // The site renders late; the predicate must not depend on that, but the DOM must exist.
        await sleep(12000);

        const state = await evaluate(conn, HARNESS);

        check('the idle page reads as closed', state.idle === false, 'got ' + state.idle);
        check('a challenge on screen reads as open', state.onScreen === true, 'got ' + state.onScreen);
        check('a transparent challenge reads as closed', state.transparent === false, 'got ' + state.transparent);
        check('a parked container reads as closed despite its size',
            state.parked === false, 'got ' + state.parked);
        check('the page is left as it was found',
            state.restored === state.idle, 'idle=' + state.idle + ' restored=' + state.restored);
    } finally {
        if (conn) conn.close();
        await session.cleanup();
    }

    const failed = results.filter(ok => !ok).length;
    console.log('');
    if (failed) {
        console.error(`${failed}/${results.length} live challenge guard checks failed`);
        process.exitCode = 1;
    } else {
        console.log(`PASS: ${results.length}/${results.length} live challenge guard checks`);
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
