// Measures how long the detection page needs before its editor exists.
//
// Earlier probes waited a fixed 7-9s and found nothing, then reported "no editor",
// which read like the page had no input at all. A blank screenshot in one of those
// runs suggests the page simply had not finished rendering. This samples the DOM
// over time so the wait is based on measurement instead of a guess.
const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9386;
const SITE = 'https://matrix.tencent.com/ai-detect/';

const { sleep, httpJson, cdp, launch } = require('../browser-harness.cjs');

(async () => {
    const session = await launch({ browser: BROWSER, port: PORT, prefix: 'zqwait' });

    try {
        const target = await httpJson(PORT, '/json/new?about:blank', 'PUT');
        const page = await cdp(target.webSocketDebuggerUrl);

        await page.send('Page.enable');
        await page.send('Runtime.enable');
        await page.send('Page.navigate', { url: SITE });

        for (let i = 1; i <= 14; i++) {
            await sleep(3000);

            const probe = await page.send('Runtime.evaluate', {
                expression: `(() => {
                    const body = document.body ? document.body.innerText : '';
                    return JSON.stringify({
                        bodyLen: body.length,
                        textareas: document.querySelectorAll('textarea').length,
                        contentEditables: document.querySelectorAll('[contenteditable="true"]').length,
                        inputs: document.querySelectorAll('input').length,
                        buttons: document.querySelectorAll('button').length
                    });
                })()`,
                returnByValue: true
            });

            process.stdout.write(`t+${i * 3}s  ${probe.result.value}\n`);
        }
    } finally {
        await session.cleanup();
    }
})();
