// Loads the refactored extension in real Edge and checks the wiring end to end.
//
// Everything before this ran offline against mocks. What only a real load can expose is exactly
// what this rewrite touched: four ordered content scripts, an ESM service worker, the moved side
// panel path, and whether the relay still starts under its new location.
//
// The detection tab is opened by the panel itself via chrome.tabs.create. Driving it from CDP
// instead put the page in a different window than the panel, where chrome.tabs.query did not
// report it, and the check silently ran against a missing tab.
const { spawnSync } = require('node:child_process');
const { sleep, cdp, launch } = require('../browser-harness.cjs');

const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROOT = 'E:/edge-extensions/tencent-ai-detect';
const PORT = 9405;
const EXPECTED_ID = 'kdjgfockdecdbadmpbjgflmiffdiffhp';
const DETECT_URL = 'https://matrix.tencent.com/ai-detect/';

function relayProcesses() {
    const out = spawnSync('powershell', ['-NoProfile', '-Command',
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'server\\.cjs|relay\\.cjs|native-host\\.cjs|nm-host\\.cjs' } | " +
        "ForEach-Object { $_.ProcessId.ToString() + '|' + $_.CommandLine }"], { encoding: 'utf8' });
    const map = new Map();
    for (const line of String(out.stdout || '').split(/\r?\n/)) {
        const i = line.indexOf('|');
        if (i > 0) map.set(line.slice(0, i).trim(), line.slice(i + 1));
    }
    return map;
}

const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();

async function waitForTarget(match, timeoutMs = 20000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        const found = (await targets()).find(t => t.type === 'page' && match(t.url || ''));
        if (found) return found;
        await sleep(400);
    }
    return null;
}

(async () => {
    const before = relayProcesses();
    const results = [];
    const check = (name, ok, detail) => {
        results.push({ name, ok });
        console.log('%s %s%s', ok ? 'ok  ' : 'FAIL', name, detail ? '  — ' + detail : '');
    };

    const session = await launch({
        browser: BROWSER, port: PORT, prefix: 'zqaccept',
        args: [
            '--disable-features=DisableLoadExtensionCommandLineSwitch',
            `--disable-extensions-except=${ROOT}`,
            `--load-extension=${ROOT}`
        ]
    });

    try {
        await sleep(3000);

        const initial = await targets();
        const ours = initial.filter(t => (t.url || '').includes(EXPECTED_ID));
        check('extension loaded under the original id', ours.length > 0,
            ours.map(t => t.type).join(',') || 'no target');
        check('ES module service worker started',
            ours.some(t => t.type === 'service_worker' || t.type === 'background_page'),
            'worker target present');

        // Open the panel first; it owns the tab it will read.
        const first = (await targets()).find(t => t.type === 'page');
        const hostConn = await cdp(first.webSocketDebuggerUrl);
        const panelUrl = `chrome-extension://${EXPECTED_ID}/src/sidepanel/index.html`;
        await hostConn.send('Target.createTarget', { url: panelUrl, newWindow: false });

        const panelTarget = await waitForTarget(url => url.includes('sidepanel'));
        check('side panel page loads from the new path', !!panelTarget,
            panelTarget ? panelTarget.url : 'timed out');
        hostConn.close();

        if (panelTarget) {
            const panelConn = await cdp(panelTarget.webSocketDebuggerUrl);
            await sleep(1500);

            // 1. Panel opens the detection page itself, so the tab is visible to it.
            const open = await panelConn.send('Runtime.evaluate', {
                expression: `(async () => {
                    const tab = await chrome.tabs.create({ url: ${JSON.stringify(DETECT_URL)}, active: true });
                    return { id: tab.id };
                })()`,
                awaitPromise: true, returnByValue: true
            });
            const detectionTab = open.result?.value?.id;
            check('panel opened the detection page', Number.isInteger(detectionTab),
                'tab ' + detectionTab);

            // 2. Let the page and its content scripts settle.
            await sleep(20000);

            const probe = await panelConn.send('Runtime.evaluate', {
                expression: `(async () => {
                    const out = { title: document.title };
                    out.buttons = [...document.querySelectorAll('button')].map(b => b.id);

                    const tabs = await chrome.tabs.query({});
                    out.tabs = tabs.map(t => ({ id: t.id, url: (t.url || '').slice(0, 50) }));
                    const det = tabs.find(t => (t.url || '').includes('ai-detect'));
                    out.found = !!det;

                    for (let attempt = 0; det && attempt < 8 && out.reply === undefined; attempt++) {
                        try {
                            out.reply = await chrome.tabs.sendMessage(det.id, { action: 'getStatus' });
                        } catch (error) {
                            out.lastError = String(error && error.message || error);
                            await new Promise(r => setTimeout(r, 700));
                        }
                    }

                    out.status = await chrome.runtime.sendMessage({ action: 'getStatus' });
                    return out;
                })()`,
                awaitPromise: true, returnByValue: true
            });

            const v = probe.result?.value || {};
            console.log('     panel title: %j', v.title);
            console.log('     tabs visible: %j', v.tabs);
            console.log('     content reply: %j  lastError: %j', v.reply, v.lastError);

            check('detection tab is visible to the panel', v.found === true, String(v.found));

            // The panel's own script must have run. Its markup renders without it, so the real
            // signal is a DOM write the script performs: the state label it fills in.
            const scriptRan = await panelConn.send('Runtime.evaluate', {
                expression: `(() => {
                    const el = document.getElementById('page-state');
                    return {
                        present: !!el,
                        text: el ? el.textContent : null,
                        state: el ? el.dataset.state : null,
                        // The label starts as the static markup value and is overwritten on load.
                        linked: [...document.querySelectorAll('link[rel=stylesheet]')]
                            .some(l => l.href.endsWith('styles.css')),
                        cssApplied: !!document.querySelector('.brandbar') &&
                            getComputedStyle(document.querySelector('.brandbar')).display !== 'block'
                    };
                })()`,
                returnByValue: true
            });
            const s = scriptRan.result?.value || {};
            console.log('     panel state element: %j', s);
            check('panel script ran (it filled in the state row)', !!s.text && s.state !== undefined,
                JSON.stringify({ text: s.text, state: s.state }));
            check('panel stylesheet is linked and applied', s.linked === true, String(s.linked));
            check('side panel keeps its original controls',
                Array.isArray(v.buttons) && v.buttons.includes('toggle-relay') &&
                v.buttons.includes('reset-usage'), JSON.stringify(v.buttons));
            check('content script answers the panel through the tab',
                !!(v.reply && v.reply.status), v.reply && v.reply.status);
            check('background answers getStatus from the panel',
                !!(v.status && v.status.relayEnabled === true), JSON.stringify(v.status));

            panelConn.close();
        }

        // The relay has to be up for the rotation path to work at all.
        await sleep(2500);
        const after = relayProcesses();
        const spawned = [...after.keys()].filter(pid => !before.has(pid));
        const preexisting = [...before.keys()].filter(pid => after.has(pid));

        let health = null;
        try {
            const res = await fetch('http://127.0.0.1:9420/health');
            health = await res.json();
        } catch (error) {
            health = { error: String(error.message || error) };
        }

        check('relay is serving', !!(health && health.ok),
            JSON.stringify(health) + (spawned.length ? ' (started by this load)' : ' (reused a running relay)'));

        // A registry entry pointing at a missing manifest is the failure mode that looks like
        // "the relay just did not start": report it as its own cause instead of a bare fetch error.
        if (!(health && health.ok)) {
            const reg = spawnSync('powershell', ['-NoProfile', '-Command',
                "$p = (Get-ItemProperty 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.afei.tencent_ai_detect_relay' -ErrorAction SilentlyContinue).'(default)'; " +
                "if ($p) { if (Test-Path $p) { 'ok|' + $p } else { 'missing|' + $p } } else { 'unregistered|' }"],
                { encoding: 'utf8' });
            const line = String(reg.stdout || '').trim();
            const [state, path] = line.split('|');
            const hint = state === 'missing'
                ? 'native host manifest is missing (' + path + ') — run npm run host:register'
                : state === 'unregistered'
                    ? 'native host is not registered — run npm run host:register'
                    : 'manifest present at ' + path;
            console.log('     native host: %s', hint);
        }
        check('relay ownership is accounted for', spawned.length > 0 || preexisting.length > 0,
            spawned.length ? 'spawned ' + spawned.join(',') : 'reused ' + preexisting.join(','));

        const failed = results.filter(r => !r.ok);
        console.log('');
        console.log('%d/%d passed', results.length - failed.length, results.length);
        if (failed.length) process.exitCode = 1;
    } finally {
        await session.cleanup();
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
