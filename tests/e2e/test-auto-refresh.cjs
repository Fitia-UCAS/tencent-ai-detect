// Proves what the page does when the allowance runs out, for each answer the panel offers.
//
// The answer is a stored choice, so this drives both sides of it: a page set to keep itself must stay
// exactly where it is, and a page set to swap must swap with no click from the user. The first half
// exists because it was broken - the setting was honoured by one of the two paths that noticed a
// spent address and ignored by the other, so the page reloaded under a user who had asked it not to.
//
// Reload detection uses a marker written to the window before the wait. A reload destroys the
// window, so the marker disappearing is proof the page navigated rather than the text being
// replaced in place.
const path = require('node:path');
const http = require('node:http');
const { sleep, httpJson, cdp, launch } = require('../../tools/browser-harness.cjs');

const EXT = path.resolve(__dirname, '..', '..');
const EXT_ID = 'kdjgfockdecdbadmpbjgflmiffdiffhp';

// The relay is asked from Node, not from the page: an https page cannot fetch an http loopback
// URL, so a probe issued inside the page fails for reasons that have nothing to do with the relay.
function relayHealthy(port = 9420) {
    return new Promise(resolve => {
        const request = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                try {
                    resolve(JSON.parse(body).ok === true);
                } catch {
                    resolve(false);
                }
            });
        });
        request.on('timeout', () => { request.destroy(); resolve(false); });
        request.on('error', () => resolve(false));
    });
}const PORT = 9481;
const SITE = 'https://matrix.tencent.com/ai-detect/';

const { resolveBrowser } = require('../../tools/machine.cjs');
const BROWSER = resolveBrowser();

const failures = [];
const ok = text => process.stdout.write(`  ok    ${text}\n`);
const fail = text => {
    failures.push(text);
    process.stdout.write(`  FAIL  ${text}\n`);
};

(async () => {
    const env = await launch({
        browser: BROWSER,
        port: PORT,
        prefix: 'zqe2e',
        args: [
            `--disable-extensions-except=${EXT}`,
            `--load-extension=${EXT}`,
            // Off-screen and muted: this run is a measurement, not something to look at, and a window
            // that takes focus also takes it away from whoever is using the machine.
            '--window-position=-32000,-32000',
            '--window-size=900,700',
            '--mute-audio'
        ]
    });

    try {
        // The worker is where a tab can be opened from.
        let worker = null;
        for (let i = 0; i < 40 && !worker; i += 1) {
            const targets = await httpJson(PORT, '/json/list');
            // Matched by this extension's own id. The profile also runs several built-in extensions,
            // and two of them have a service worker whose url contains "background" - picking by that
            // word attached to one of theirs, where chrome.storage is not the extension's storage area
            // at all, so a write there silently went nowhere.
            const sw = (targets || []).find(t => t.type === 'service_worker' && (t.url || '').includes(EXT_ID));
            if (sw) worker = await cdp(sw.webSocketDebuggerUrl);
            else await sleep(300);
        }
        if (!worker) throw new Error('the service worker never started');

        await worker.send('Runtime.evaluate', {
            expression: `chrome.tabs.create({ url: ${JSON.stringify(SITE)}, active: true })`,
            awaitPromise: true
        });

        let page = null;
        for (let i = 0; i < 40 && !page; i += 1) {
            const targets = await httpJson(PORT, '/json/list');
            page = (targets || []).find(t => (t.url || '').includes('matrix.tencent.com'));
            if (!page) await sleep(300);
        }
        if (!page) throw new Error('the detection page never opened');

        const pageConn = await cdp(page.webSocketDebuggerUrl);

        // Contexts are announced as they are created, so the listener has to exist before the page
        // settles; the extension's isolated world is the one named after it, and a reload creates a
        // fresh one, which is why the last entry is the one to read afterwards.
        const contexts = [];
        pageConn.on(msg => {
            if (msg.method === 'Runtime.executionContextCreated') {
                const context = msg.params.context;
                if (context.name && context.name.includes('Tencent AI Detect')) contexts.push(context);
            }
        });

        await pageConn.send('Runtime.enable');
        await pageConn.send('Page.enable');

        // Let the first injection settle and the relay come up.
        await sleep(9000);

        const relay = await relayHealthy();
        relay ? ok('the relay answers, so a rotation can complete') : fail('the relay is not answering');

        // The exhausting text is written once and survives the first half, because a page set to keep
        // itself must not navigate. The counter wording is replaced rather than supplemented: adding
        // the exhausted sentence while a positive counter is still on screen is correctly treated as
        // stale, so that would not be a faithful simulation.
        const markExhausted = () => pageConn.send('Runtime.evaluate', {
            expression: `(() => {
                window.__zqProbe = 'before';

                const button = [...document.querySelectorAll('button')]
                    .find(b => (b.textContent || '').includes('检测'));
                if (!button) return 'no detect button';

                button.textContent = '今日次数已用完';
                return document.body.innerText;
            })()`,
            returnByValue: true
        });

        const stillThere = async () => {
            const marker = await pageConn.send('Runtime.evaluate', {
                expression: `window.__zqProbe || ''`,
                returnByValue: true
            }).catch(() => ({ result: { value: '' } }));
            return (marker.result && marker.result.value) === 'before';
        };

        const setMode = mode => worker.send('Runtime.evaluate', {
            expression: `chrome.storage.local.set({ spentMode: ${JSON.stringify(mode)} })`,
            awaitPromise: true
        });

        // A stored preference reaches the page through the storage change listener, so it is set
        // before the page is made to look spent - otherwise the first tick decides for the old one.
        await setMode('manual');

        // The site is a slow client: measured, its detect control is absent for the first ten seconds
        // and the page only reaches "complete" after fifteen. Waiting a fixed nine seconds and then
        // looking for the button is how this check came to report the state as unreproducible.
        let buttonReady = false;
        for (let i = 0; i < 30 && !buttonReady; i += 1) {
            const probe = await pageConn.send('Runtime.evaluate', {
                expression: `[...document.querySelectorAll('button')].some(b => (b.textContent || '').includes('检测'))`,
                returnByValue: true
            }).catch(() => ({ result: { value: false } }));
            buttonReady = !!(probe.result && probe.result.value);
            if (!buttonReady) await sleep(1000);
        }

        buttonReady
            ? ok('the detection page finished starting up')
            : fail('the detect control never appeared');

        const marked = await markExhausted();
        const bodyText = marked.result && marked.result.value;
        const exhaustedNow = typeof bodyText === 'string' &&
            bodyText.includes('今日次数已用完') &&
            !/今日剩余\s*\d+\s*次/.test(bodyText);

        exhaustedNow
            ? ok('the page reads exactly as it does when the allowance is gone')
            : fail('the exhausted state was not reproduced');

        // The watchdog ticks every two seconds, so ten of them is far past the point at which the old
        // code had already reloaded - it decided about a second after the wording appeared.
        let moved = false;
        for (let i = 0; i < 10; i += 1) {
            await sleep(1000);
            if (!(await stillThere())) { moved = true; break; }
        }

        moved
            ? fail('the page reloaded under "wait for me"; the setting was ignored')
            : ok('a page set to keep itself is left exactly where it is');

        // The other half of the same setting: when the swap is wanted, it has to happen without a
        // click. The page is still reading as spent, so switching the mode is the only change.
        await setMode('immediate');

        let navigated = false;
        for (let i = 0; i < 20; i += 1) {
            await sleep(1000);
            if (!(await stillThere())) { navigated = true; break; }
        }

        navigated
            ? ok('with a swapping mode the page reloads on its own, without any click')
            : fail('the page never reloaded with swapping selected; the allowance would stay spent');

        // After the reload the extension must come back up and pick a fresh address. The injected
        // flag lives in the content script's own world, so it is read through the newest isolated
        // context rather than from the page's main world.
        if (navigated) {
            await sleep(7000);

            const isolated = contexts[contexts.length - 1];

            const after = isolated
                ? await pageConn.send('Runtime.evaluate', {
                    contextId: isolated.id,
                    expression: `(() => {
                        const raw = localStorage.getItem('zqRotationState');
                        return JSON.stringify({
                            injected: !!window.__zqDetectReady,
                            rotations: raw ? JSON.parse(raw).rotations : 0
                        });
                    })()`,
                    returnByValue: true
                })
                : null;

            const parsed = JSON.parse((after && after.result && after.result.value) || '{}');

            parsed.injected
                ? ok('the extension is running again after the reload')
                : fail('the content script did not come back after the reload');

            parsed.rotations > 0
                ? ok(`a rotation was recorded (rotations=${parsed.rotations})`)
                : fail('no rotation was recorded');
        }

        pageConn.close();
        worker.close();
    } finally {
        await env.cleanup();
    }

    if (failures.length) {
        process.stdout.write(`\nFAIL: ${failures.length} check(s)\n`);
        process.exitCode = 1;
    } else {
        process.stdout.write('\nPASS: the stored answer decides what the page does when spent\n');
    }
})().catch(error => {
    process.stderr.write(`harness failed: ${error.message}\n`);
    process.exitCode = 2;
});
