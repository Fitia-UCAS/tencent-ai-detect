// Proves the page refreshes itself when the allowance runs out, with no click from the user.
//
// The requirement is not "it can rotate"; it is "the user does nothing". So this test never
// presses anything: it makes the page read as exhausted and then watches for a navigation that
// the extension has to perform on its own.
//
// Reload detection uses a marker written to the window before the wait. A reload destroys the
// window, so the marker disappearing is proof the page navigated rather than the text being
// replaced in place.
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { sleep, httpJson, cdp, launch } = require('../../tools/browser-harness.cjs');

const EXT = path.resolve(__dirname, '..', '..');

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

const EDGE = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

const failures = [];
const ok = text => process.stdout.write(`  ok    ${text}\n`);
const fail = text => {
    failures.push(text);
    process.stdout.write(`  FAIL  ${text}\n`);
};

(async () => {
    if (!EDGE) throw new Error('Edge not found');

    const env = await launch({
        browser: EDGE,
        port: PORT,
        prefix: 'zqe2e',
        args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
    });

    try {
        // The worker is where a tab can be opened from.
        let worker = null;
        for (let i = 0; i < 40 && !worker; i += 1) {
            const targets = await httpJson(PORT, '/json/list');
            const sw = (targets || []).find(t => t.type === 'service_worker' && (t.url || '').includes('background'));
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

        // Make the page read the way it does when the allowance is actually gone: the control's
        // counter wording is replaced, so no "今日剩余N次" remains anywhere. Adding the exhausted
        // sentence while a positive counter is still on screen is correctly treated as stale, so
        // that is not a faithful simulation.
        const marked = await pageConn.send('Runtime.evaluate', {
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

        const bodyText = marked.result && marked.result.value;
        const exhaustedNow = typeof bodyText === 'string' &&
            bodyText.includes('今日次数已用完') &&
            !/今日剩余\s*\d+\s*次/.test(bodyText);

        exhaustedNow
            ? ok('the page reads exactly as it does when the allowance is gone')
            : fail('the exhausted state was not reproduced');

        // The watchdog runs every five seconds and a rotation reloads 1.2s after it decides, so
        // twenty seconds covers a full cycle without being so long that a failure looks like a hang.
        let navigated = false;
        for (let i = 0; i < 20; i += 1) {
            await sleep(1000);
            const marker = await pageConn.send('Runtime.evaluate', {
                expression: `window.__zqProbe || ''`,
                returnByValue: true
            }).catch(() => ({ result: { value: '' } }));

            if ((marker.result && marker.result.value) === '') { navigated = true; break; }
        }

        navigated
            ? ok('the page reloaded on its own, without any click')
            : fail('the page never reloaded; the allowance would stay spent');

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
        process.stdout.write('\nPASS: the allowance refreshes itself\n');
    }
})().catch(error => {
    process.stderr.write(`harness failed: ${error.message}\n`);
    process.exitCode = 2;
});
