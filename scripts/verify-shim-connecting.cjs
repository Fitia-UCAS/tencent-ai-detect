// Verifies, in a real browser with the real extension loaded, that sending while
// the wrapper socket is still CONNECTING no longer throws.
//
// The extension error page keeps a history of past exceptions, so a stale entry
// there cannot be told apart from a live one by looking at it. This drives the
// exact condition instead: it reaches into the shimmed socket and calls send()
// while readyState is still CONNECTING, then reports any uncaught exception.
const path = require('node:path');
const fs = require('node:fs');

const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9389;
const EXT = path.join(__dirname, '..');
const SITE = 'https://matrix.tencent.com/ai-detect/';

const { sleep, httpJson, cdp, launch } = require('./browser-harness.cjs');

(async () => {
    let session = null;
    const failures = [];
    const ok = m => process.stdout.write(`  ok    ${m}\n`);
    const fail = m => { failures.push(m); process.stdout.write(`  FAIL  ${m}\n`); };

    try {
        session = await launch({
            browser: BROWSER,
            port: PORT,
            prefix: 'zqstate',
            args: [`--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`]
        });

        const target = await httpJson(PORT, '/json/new?about:blank', 'PUT');
        const page = await cdp(target.webSocketDebuggerUrl);

        await page.send('Page.enable');
        await page.send('Runtime.enable');

        const exceptions = [];

        page.on(msg => {
            if (msg.method === 'Runtime.exceptionThrown') {
                const d = msg.params.exceptionDetails;
                exceptions.push(d.text);
                process.stdout.write(`  EXCEPTION ${d.text}\n`);
            }
        });

        await page.send('Page.navigate', { url: SITE });
        await sleep(8000);

        // Confirm the shim actually took over, otherwise the native socket is
        // being tested and the result means nothing.
        const shimmed = await page.send('Runtime.evaluate', {
            expression: 'typeof window.__zqRelayShim !== "undefined" && window.__zqRelayShim === true',
            returnByValue: true
        });

        if (shimmed.result.value === true) ok('shim is installed in the page world');
        else { fail('shim did not install; the result below would be meaningless'); }

        // Drive the real failure condition: construct a relay-backed socket and
        // send immediately, which is CONNECTING at that moment.
        const probe = await page.send('Runtime.evaluate', {
            expression: `(() => {
                try {
                    const s = new WebSocket('wss://matrix.tencent.com/ai_gen_txt_server/getClassify');
                    const stateAtSend = s.readyState;
                    let threw = null;
                    try {
                        s.send(JSON.stringify({ fp: 'probe-fp' }));
                    } catch (e) {
                        threw = e.name + ': ' + e.message;
                    }
                    setTimeout(() => { try { s.close(); } catch (e) {} }, 2000);
                    return JSON.stringify({ stateAtSend, threw, pending: (s._pendingSends || []).length });
                } catch (e) {
                    return JSON.stringify({ constructError: e.name + ': ' + e.message });
                }
            })()`,
            returnByValue: true
        });

        const result = JSON.parse(probe.result.value);
        process.stdout.write(`  probe: ${probe.result.value}\n`);

        if (result.constructError) {
            fail(`constructing the socket threw: ${result.constructError}`);
        } else if (result.stateAtSend !== 0) {
            // readyState 0 is CONNECTING; anything else means the condition was
            // not reproduced and the check below proves nothing.
            fail(`socket was not CONNECTING at send time (readyState=${result.stateAtSend})`);
        } else {
            ok('socket was CONNECTING when send() was called');
        }

        if (result.threw) fail(`send() threw while connecting: ${result.threw}`);
        else if (!result.constructError) ok('send() while connecting did not throw');

        if (result.pending >= 1) ok('the frame was queued instead of dropped');
        else if (!result.constructError) fail('the frame was not queued');

        await sleep(1000);

        if (exceptions.length === 0) ok('no uncaught exception reached the page');
        else fail(`${exceptions.length} uncaught exception(s): ${exceptions.join(' | ')}`);
    } catch (error) {
        fail(error.message);
    } finally {
        if (session) await session.cleanup();
    }

    if (failures.length) {
        process.stdout.write(`\n${failures.length} check(s) failed\n`);
        process.exitCode = 1;
    } else {
        process.stdout.write('\nall checks passed\n');
    }
})();
