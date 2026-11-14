// Prints the extension's diagnostic log.
//
// Two sources, because they fail independently:
//   - host.log on disk, written by the native host. Always readable, and it carries the worker's
//     error lines mirrored down the native port. A host that never started leaves this empty, which
//     is itself the answer.
//   - the worker's ring buffer in chrome.storage, which survives the service worker being torn
//     down. Readable only through the browser, so it needs a debug port.
//
// Usage:
//   npm run log:dump              print both sources
//   npm run log:dump -- --file    disk log only
//   npm run log:dump -- --port=9222
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
const fileOnly = args.includes('--file');
const portArg = args.find(a => a.startsWith('--port='));
const PORT = portArg ? Number(portArg.split('=')[1]) : 9222;

const HOST_LOG = path.join(os.homedir(), '.tencent-ai-detect-keys', 'host.log');
const EXTENSION_ID = 'kdjgfockdecdbadmpbjgflmiffdiffhp';

function printHostLog() {
    console.log('=== host.log ===');
    console.log('    ' + HOST_LOG);

    if (!fs.existsSync(HOST_LOG)) {
        console.log('    (missing)');
        console.log('');
        console.log('    The native host has never started, so it wrote nothing. That is the finding:');
        console.log('    the relay cannot come up. Check that the host is registered and that the');
        console.log('    manifest it names exists.');
        return;
    }

    const size = fs.statSync(HOST_LOG).size;
    const text = fs.readFileSync(HOST_LOG, 'utf8');
    const lines = text.split(/\r?\n/).filter(Boolean);

    console.log('    ' + size + ' bytes, ' + lines.length + ' lines, showing the last 40');
    console.log('');
    for (const line of lines.slice(-40)) console.log('    ' + line);
}

async function printWorkerLog() {
    console.log('');
    console.log('=== worker ring buffer ===');

    let targets;
    try {
        const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
        targets = await response.json();
    } catch (error) {
        console.log(`    (no debug port on ${PORT})`);
        console.log('');
        console.log('    The buffer needs a browser debug port. Either start Edge with');
        console.log(`    --remote-debugging-port=${PORT}, or use --file for the disk log alone.`);
        return;
    }

    // The extension's service worker, then its side panel: storage is per-extension, so either
    // target can read it.
    const target = targets.find(t => (t.url || '').includes(EXTENSION_ID));
    if (!target) {
        console.log(`    (extension ${EXTENSION_ID} is not loaded in this browser)`);
        return;
    }

    const { cdp } = require('./browser-harness.cjs');
    const conn = await cdp(target.webSocketDebuggerUrl);

    try {
        const result = await conn.send('Runtime.evaluate', {
            expression: `new Promise(resolve => chrome.storage.local.get(['diagnosticsLog'], r => resolve(r.diagnosticsLog || [])))`,
            awaitPromise: true,
            returnByValue: true
        });

        const entries = result.result?.value || [];
        if (!entries.length) {
            console.log('    (empty)');
            return;
        }

        console.log('    ' + entries.length + ' entries');
        console.log('');
        for (const entry of entries.slice(-60)) {
            const at = new Date(entry.t).toISOString().replace('T', ' ').slice(0, 19);
            console.log(`    ${at}  ${String(entry.level).padEnd(5)}  ${entry.text}`);
        }
    } finally {
        conn.close();
    }
}

(async () => {
    printHostLog();
    if (!fileOnly) await printWorkerLog();
})().catch(error => {
    console.error('log:dump failed:', error.message);
    process.exitCode = 1;
});
