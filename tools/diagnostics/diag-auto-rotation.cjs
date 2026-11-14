// Verifies the content script rotates on a page that already shows an exhausted allowance.
//
// The unit tests drive the engine with a mocked page. This loads the real extension, opens the real
// detection page, and checks the rotation actually happens without a click: the state the panel
// receives, and whether the content script recorded a rotation.
//
// A fresh browser profile usually still has allowance, so the run reports which state it found.
// When the page reports allowance it says so instead of pretending to have tested exhaustion.
const { sleep, cdp, launch } = require('../browser-harness.cjs');

const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = 'E:/edge-extensions/tencent-ai-detect';
const PORT = 9413;
const EXPECTED_ID = 'kdjgfockdecdbadmpbjgflmiffdiffhp';
const DETECT_URL = 'https://matrix.tencent.com/ai-detect/';

const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();

async function waitForTarget(match, timeoutMs = 25000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        const found = (await targets()).find(t => t.type === 'page' && match(t.url || ''));
        if (found) return found;
        await sleep(400);
    }
    return null;
}

(async () => {
    const results = [];
    const check = (name, ok, detail) => {
        results.push({ name, ok });
        console.log('%s %s%s', ok ? 'ok  ' : 'FAIL', name, detail ? '  - ' + detail : '');
    };

    const session = await launch({
        browser: BROWSER, port: PORT, prefix: 'zqautorot',
        args: [
            '--disable-features=DisableLoadExtensionCommandLineSwitch',
            `--disable-extensions-except=${ROOT}`,
            `--load-extension=${ROOT}`
        ]
    });

    try {
        await sleep(2500);
        const first = (await targets()).find(t => t.type === 'page');
        const hostConn = await cdp(first.webSocketDebuggerUrl);

        const panelUrl = `chrome-extension://${EXPECTED_ID}/src/sidepanel/index.html`;
        await hostConn.send('Target.createTarget', { url: panelUrl, newWindow: false });
        const panelTarget = await waitForTarget(url => url.includes('sidepanel'));
        hostConn.close();
        if (!panelTarget) throw new Error('side panel did not open');

        const panelConn = await cdp(panelTarget.webSocketDebuggerUrl);
        await sleep(1200);

        // Open the detection page from the panel so the tab belongs to the same window.
        await panelConn.send('Runtime.evaluate', {
            expression: `chrome.tabs.create({ url: ${JSON.stringify(DETECT_URL)}, active: true })`,
            awaitPromise: true
        });
        const pageTarget = await waitForTarget(url => url.includes('matrix.tencent.com'));
        check('detection page opened', !!pageTarget, pageTarget ? pageTarget.url : 'timed out');
        if (!pageTarget) throw new Error('no detection page');

        // Let the page settle and the content script report.
        await sleep(20000);

        const read = async () => {
            const res = await panelConn.send('Runtime.evaluate', {
                expression: `(async () => {
                    const tabs = await chrome.tabs.query({});
                    const det = tabs.find(t => (t.url || '').includes('ai-detect'));
                    if (!det) return { missing: true };
                    for (let i = 0; i < 5; i++) {
                        try {
                            const reply = await chrome.tabs.sendMessage(det.id, { action: 'getStatus' });
                            if (reply) return { status: reply.status, rotations: reply.rotations, remaining: reply.remaining };
                        } catch {}
                        await new Promise(r => setTimeout(r, 500));
                    }
                    return { silent: true };
                })()`,
                awaitPromise: true, returnByValue: true
            });
            return res.result?.value || {};
        };

        const before = await read();
        console.log('     initial state: %j', before);

        if (before.status !== 'quota') {
            console.log('     page still has allowance (%s left) - exhaustion cannot be reached without',
                before.remaining);
            console.log('     spending it, so the auto-rotation path is covered by the unit tests only');
            check('content script reports a state', !!before.status, JSON.stringify(before));
        } else {
            // The page already shows exhaustion. With the watchdog in place this must rotate on its
            // own, with no click and no reload by hand.
            console.log('     page shows exhaustion - waiting for the watchdog (5s tick)...');
            await sleep(9000);
            const after = await read();
            console.log('     state after watchdog: %j', after);
            check('the watchdog rotated without a click',
                Number(after.rotations) > Number(before.rotations || 0),
                `rotations ${before.rotations} -> ${after.rotations}`);
        }

        panelConn.close();

        const failed = results.filter(r => !r.ok);
        console.log('');
        console.log('%d/%d passed', results.length - failed.length, results.length);
        if (failed.length) process.exitCode = 1;
    } finally {
        await session.cleanup();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
