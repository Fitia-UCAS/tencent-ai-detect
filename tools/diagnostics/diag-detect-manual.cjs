// Interactive frame recorder for a full detection attempt.
//
// The site answers a bad fingerprint with success/5 and only rejects the captcha
// ticket frame, but it never explains why. This opens a normal, visible browser
// window with only the shim injected, so the user can press the detect button and pass
// the captcha by hand while every frame in both directions is recorded.
//
// Usage:
//   node scripts/diag-detect-manual.cjs            # relay spoofs an address
//   node scripts/diag-detect-manual.cjs --no-spoof # relay sends the real one
//
// The second form decides the IP-binding question: if the ticket is only refused
// when the socket claims a different address than the one the captcha was issued
// for, it succeeds here.
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9396;
const RELAY_PORT = 9420;
const SITE = 'https://matrix.tencent.com/ai-detect/';

const { sleep, httpJson, cdp, launch } = require('../browser-harness.cjs');

const NO_SPOOF = process.argv.includes('--no-spoof');

function label(payload) {
    const raw = String(payload);

    if (/availableUses/.test(raw)) return 'USES  ';
    if (/"ticket"/.test(raw)) return 'TICKET';
    if (/"fp"/.test(raw)) return 'FP    ';
    if (/"access_token"/.test(raw)) return 'TOKEN ';
    if (/"text"/.test(raw)) return 'TEXT  ';
    if (/"msg"/.test(raw)) return 'REJECT';
    return 'OTHER ';
}

function show(payload) {
    const raw = String(payload);

    return raw.length > 400 ? `${raw.slice(0, 360)}… (${raw.length} chars)` : raw;
}

function startRelay() {
    const env = { ...process.env };
    if (NO_SPOOF) env.RELAY_NO_SPOOF = '1';

    const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'relay', 'server.cjs')], {
        env,
        stdio: 'ignore',
        windowsHide: true
    });

    return child;
}

async function waitForRelay() {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        try {
            const body = await httpJson(RELAY_PORT, '/health');
            if (body && body.service === 'zq-local-relay-v1') return true;
        } catch (e) {
        }
        await sleep(200);
    }
    return false;
}

(async () => {
    let session = null;
    let relay = null;

    try {
        // The extension must not be running: its worker revives the relay on an
        // alarm and would replace the --no-spoof instance with a spoofing one.
        process.stdout.write(NO_SPOOF
            ? 'relay mode: NO SPOOF (socket reports the real address)\n'
            : 'relay mode: spoofing (each connection gets a synthetic address)\n');

        const health = await httpJson(RELAY_PORT, '/health').catch(() => null);
        if (health && health.service === 'zq-local-relay-v1') {
            process.stdout.write(
                'a relay is already running. Stop the extension or run `npm run stop:relay` first,\n' +
                'otherwise this test cannot control the spoofing mode.\n'
            );
            process.exitCode = 1;
            return;
        }

        relay = startRelay();

        if (!await waitForRelay()) {
            process.stdout.write('relay did not come up\n');
            process.exitCode = 1;
            return;
        }

        session = await launch({ browser: BROWSER, port: PORT, prefix: 'zqmanual' });

        const target = await httpJson(PORT, '/json/new?about:blank', 'PUT');
        const page = await cdp(target.webSocketDebuggerUrl);

        const shim = fs.readFileSync(path.join(__dirname, '..', '..', 'shim.js'), 'utf8');

        await page.send('Page.enable');
        await page.send('Runtime.enable');
        await page.send('Network.enable');
        await page.send('Page.addScriptToEvaluateOnNewDocument', { source: shim });

        let lastActivity = Date.now();
        const tally = { sent: 0, received: 0, rejected: 0 };

        page.on(msg => {
            if (msg.method === 'Network.webSocketCreated') {
                lastActivity = Date.now();
                process.stdout.write(`\nsocket ${msg.params.url}\n`);
            }

            if (msg.method === 'Network.webSocketFrameSent') {
                lastActivity = Date.now();
                tally.sent += 1;
                process.stdout.write(`  SEND ${label(msg.params.response.payloadData)} ${show(msg.params.response.payloadData)}\n`);
            }

            if (msg.method === 'Network.webSocketFrameReceived') {
                lastActivity = Date.now();
                tally.received += 1;

                const isReject = /"status"\s*:\s*"failed"/.test(String(msg.params.response.payloadData));
                if (isReject) tally.rejected += 1;

                process.stdout.write(`  RECV ${label(msg.params.response.payloadData)} ${show(msg.params.response.payloadData)}\n`);
            }
        });

        await page.send('Page.navigate', { url: SITE });

        process.stdout.write([
            '',
            'The browser window is open. Complete one detection in it:',
            '  1. Paste at least 350 characters of Chinese text into the left textarea',
            '  2. Press the detect button',
            '  3. Pass the challenge by hand',
            '',
            'Frames are printed here as they arrive. Close the window when done, or wait 5 minutes for it to end on its own.',
            ''
        ].join('\n'));

        // Keep recording until the window is closed or nothing happens for a while
        // after at least one full attempt has been observed.
        const hardDeadline = Date.now() + 5 * 60 * 1000;
        while (Date.now() < hardDeadline) {
            await sleep(1000);

            const idle = Date.now() - lastActivity;
            if (tally.sent >= 2 && idle > 30000) break;
        }

        process.stdout.write(`\nframes: sent=${tally.sent} received=${tally.received}\n`);

        if (tally.rejected) {
            process.stdout.write(`the server rejected ${tally.rejected} frame(s) — see the RECV REJECT line above\n`);
        } else if (tally.received > 1) {
            process.stdout.write('no rejection seen in this run\n');
        } else {
            process.stdout.write('no detection attempt completed before the window closed\n');
        }
    } catch (error) {
        process.stdout.write(`error: ${error.message}\n`);
        process.exitCode = 1;
    } finally {
        if (session) await session.cleanup();
        if (relay) relay.kill();
    }
})();
