// Verifies the worker's diagnostics actually reach a place a human can read.
//
// The extension failed silently for hours while every symptom was invisible: the worker's log went
// to console.debug only, and a service worker stops whenever it idles out, so the record of why the
// host was unreachable was gone by the time anyone looked. This asserts the two durable sinks:
// the ring buffer in chrome.storage, and the host's file on disk.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.resolve(__dirname, '..');
const EXT_ID = process.env.EXT_ID || 'kdjgfockdecdbadmpbjgflmiffdiffhp';
const PORT = 9389;
const HOST_LOG = path.join(os.homedir(), '.tencent-ai-detect-keys', 'host.log');

const { sleep, cdp, launch } = require('./browser-harness.cjs');

const failures = [];
const ok = m => process.stdout.write(`  ok    ${m}\n`);
const fail = m => { failures.push(m); process.stdout.write(`  FAIL  ${m}\n`); };

// Waits for the extension's service worker to register as a debug target.
async function workerTarget(timeoutMs = 20000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        try {
            const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            // Match the extension id, not just the file name: other unpacked extensions in the same
            // browser also run a background.js, and reading their storage reports an empty buffer.
            const found = targets.find(t =>
                t.type === 'service_worker' &&
                (t.url || '').includes(EXT_ID) &&
                (t.url || '').endsWith('/background.js'));
            if (found) return found;
        } catch (error) {
            // The port is not listening yet.
        }
        await sleep(400);
    }
    return null;
}

(async () => {
    const logSizeBefore = fs.existsSync(HOST_LOG) ? fs.statSync(HOST_LOG).size : 0;

    const session = await launch({
        browser: BROWSER,
        port: PORT,
        prefix: 'zqdiaglog',
        args: [
            '--disable-features=DisableLoadExtensionCommandLineSwitch',
            `--disable-extensions-except=${EXT}`,
            `--load-extension=${EXT}`
        ]
    });

    try {
        const target = await workerTarget();
        if (!target) throw new Error('the extension service worker never appeared');

        const conn = await cdp(target.webSocketDebuggerUrl);
        try {
            // Give the keepalive alarm its first tick, which is what logs the relay state.
            let entries = [];
            const until = Date.now() + 25000;
            while (Date.now() < until) {
                const result = await conn.send('Runtime.evaluate', {
                    expression: `new Promise(r => chrome.storage.local.get(['diagnosticsLog'], v => r(v.diagnosticsLog || [])))`,
                    awaitPromise: true,
                    returnByValue: true
                });
                entries = result.result?.value || [];
                if (!Array.isArray(entries)) {
                    throw new Error('unexpected storage value: ' + JSON.stringify(entries).slice(0, 200));
                }
                if (entries.some(e => /relay/.test(e.text))) break;
                await sleep(1000);
            }

            if (entries.length) ok(`the ring buffer holds ${entries.length} entries`);
            else fail('the ring buffer is empty - the worker logged nothing durable');

            const shaped = entries.every(e =>
                typeof e.t === 'number' && typeof e.level === 'string' && typeof e.text === 'string');
            if (shaped) ok('every entry carries a timestamp, a level and text');
            else fail('entries are not shaped { t, level, text }');

            if (entries.some(e => /relay (ready|health)/.test(e.text))) {
                ok('the relay state is recorded');
            } else {
                fail('no relay state in the log: ' + JSON.stringify(entries.slice(-3)));
            }

            // The buffer must be bounded, or it grows for the life of the profile.
            if (entries.length <= 200) ok('the buffer stays within its cap');
            else fail(`the buffer is unbounded: ${entries.length} entries`);
        } finally {
            conn.close();
        }

        // The host writes its own file. A worker that cannot reach the host still leaves a disk
        // record, which is the case that matters most.
        if (!fs.existsSync(HOST_LOG)) {
            fail('the host wrote no log file at ' + HOST_LOG);
        } else {
            const size = fs.statSync(HOST_LOG).size;
            const text = fs.readFileSync(HOST_LOG, 'utf8');
            if (size > logSizeBefore) ok('the host appended to its log while running');
            else if (text.includes('[nm-host]')) ok('the host log exists and is readable');
            else fail('the host log has no host lines');

            // Format: "[nm-host] 2026-11-14T05:49:53.082Z text" - the stamp follows the prefix.
            if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text)) ok('host lines carry a timestamp');
            else fail('host lines have no timestamp');
        }
    } finally {
        await session.cleanup();
    }

    process.stdout.write('\n');
    if (failures.length) {
        process.stderr.write(`${failures.length} diagnostics checks failed\n`);
        process.exitCode = 1;
    } else {
        process.stdout.write('PASS: diagnostics reach storage and disk\n');
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
