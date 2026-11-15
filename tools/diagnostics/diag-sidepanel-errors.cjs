// Load the unpacked extension into a throwaway profile, open the side panel document as a tab, and
// print every uncaught error it raises. Read-only towards the repository: nothing is written, the
// profile is deleted on the way out.
//
// The point is to stop guessing. A side panel only exists inside a real browser, so the only honest
// way to see what it throws is to put it in one and listen to the console.
'use strict';

const path = require('path');
const fs = require('fs');
const { launch, httpJson, cdp, sleep } = require('../browser-harness.cjs');

const EXT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.ZQ_DIAG_PORT || 9333);
const { resolveBrowser } = require('../machine.cjs');
const BROWSER = resolveBrowser();

const extensionIdFromProfile = profile => {
    for (const name of ['Default/Preferences', 'Default/Secure Preferences']) {
        const file = path.join(profile, name);
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {
            continue;
        }
        const settings = (parsed.extensions && parsed.extensions.settings) || {};
        for (const [id, entry] of Object.entries(settings)) {
            const stored = String((entry && entry.path) || '').replace(/\\/g, '/').toLowerCase();
            if (stored === EXT.replace(/\\/g, '/').toLowerCase()) return id;
        }
    }
    return null;
};

const findExtensionId = async profile => {
    // The composeer's own component extensions also live under chrome-extension://, so scanning the
    // target list can hand back one of those instead. The profile's extension table is the only place
    // that ties an id to the directory we loaded.
    for (let round = 0; round < 40; round++) {
        const fromProfile = extensionIdFromProfile(profile);
        if (fromProfile) return fromProfile;
        await sleep(300);
    }
    return null;
};

(async () => {
    const session = await launch({
        browser: BROWSER,
        port: PORT,
        prefix: 'zqdiag',
        args: [`--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`]
    });

    const findings = [];
    try {
        const id = await findExtensionId(session.profile);
        if (!id) throw new Error('extension id not found; is the path loaded?');

        const pageUrl = `chrome-extension://${id}/src/sidepanel/index.html`;
        const created = await httpJson(PORT, `/json/new?${encodeURIComponent(pageUrl)}`, 'PUT');
        const targetId = created && created.id;
        if (!targetId) throw new Error('could not create the side panel target');

        const targets = await httpJson(PORT, '/json/list');
        const wsUrl = (targets || []).find(t => t.id === targetId).webSocketDebuggerUrl;
        const client = await cdp(wsUrl);

        client.on(msg => {
            if (msg.method === 'Runtime.exceptionThrown') {
                const detail = msg.params.exceptionDetails || {};
                const description = (detail.exception && detail.exception.description) || detail.text;
                findings.push({
                    kind: 'uncaught',
                    text: description,
                    url: detail.url,
                    line: detail.lineNumber + 1,
                    column: detail.columnNumber + 1
                });
            }
            if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
                const entry = msg.params.entry;
                findings.push({ kind: 'log', text: entry.text, url: entry.url, line: entry.lineNumber });
            }
        });

        await client.send('Runtime.enable');
        await client.send('Log.enable');
        await client.send('Page.enable');
        await client.send('Page.reload', { ignoreCache: true });
        await sleep(2500);

        // Ask the document what it actually bound, so "no errors" cannot be mistaken for "nothing ran".
        const probe = await client.send('Runtime.evaluate', {
            expression: `(() => ({
                title: document.title,
                url: location.href,
                ready: document.readyState,
                ids: Array.from(document.querySelectorAll('[id]')).map(n => n.id),
                cards: document.querySelectorAll('.spent-card').length,
                hasRotate: !!document.getElementById('rotate-now'),
                bodyHead: (document.body ? document.body.textContent : '').trim().slice(0, 120)
            }))()`,
            returnByValue: true
        });

        console.log('extension id:', id);
        console.log('document:', JSON.stringify(probe.result.value));

        // The service worker is where a load-time throw lands if it is not the panel. Attach to it,
        // wake it from the page, and listen: a worker that throws while nobody is watching still
        // shows up as a red error on the extensions page.
        const swList = await httpJson(PORT, '/json/list').catch(() => null);
        const worker = (swList || []).find(t => t.type === 'service_worker' && (t.url || '').includes(id));
        if (!worker || !worker.webSocketDebuggerUrl) {
            console.log('service worker: not running (no target to inspect)');
        } else {
            const swClient = await cdp(worker.webSocketDebuggerUrl);
            swClient.on(msg => {
                if (msg.method === 'Runtime.exceptionThrown') {
                    const detail = msg.params.exceptionDetails || {};
                    findings.push({
                        kind: 'worker-uncaught',
                        text: (detail.exception && detail.exception.description) || detail.text,
                        url: detail.url,
                        line: detail.lineNumber + 1
                    });
                }
                if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
                    const entry = msg.params.entry;
                    findings.push({ kind: 'worker-log', text: entry.text, url: entry.url, line: entry.lineNumber });
                }
            });
            await swClient.send('Runtime.enable');
            await swClient.send('Log.enable');
            // Any message wakes the worker; the reply is irrelevant, the side effects are not.
            await client.send('Runtime.evaluate', {
                expression: `chrome.runtime.sendMessage({ action: 'probe-wake' }, () => void chrome.runtime.lastError)`
            }).catch(() => {});
            await sleep(1500);
            swClient.close();
        }

        if (findings.length === 0) {
            console.log('errors: none');
        } else {
            console.log(`errors: ${findings.length}`);
            for (const f of findings) {
                console.log(`  [${f.kind}] ${f.text}`);
                if (f.url) console.log(`      at ${f.url}:${f.line || 1}:${f.column || 1}`);
            }
        }
        client.close();
    } finally {
        await session.cleanup();
    }
})().catch(err => {
    console.error('probe failed:', err && err.message ? err.message : err);
    process.exit(1);
});
