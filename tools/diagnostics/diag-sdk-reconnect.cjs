// Passive observation: after a WebSocket on the page is closed, does the site build another one?
//
// This answers the question the transport recovery turns on. If the site's own SDK reconnects, then
// engine.js reloading the page on top of that is a second recovery racing the first, and the reload
// should go. If it does not reconnect, something has to, and the reload is the only mechanism there
// is.
//
// Nothing here touches the relay: no process is killed and no port is taken. The probe closes one
// page-owned socket and watches whether the page opens a new one. CDP's Network domain is used as
// the observer because it sees the real socket regardless of which script wrapped it, and a
// MAIN-world hook is used only to reach the socket instance so it can be closed.
const path = require('node:path');
const fs = require('node:fs');
const { sleep, httpJson, cdp, launch } = require('../browser-harness.cjs');

const EXT = path.resolve(__dirname, '..', '..');
const PORT = 9495;
const SITE = 'https://matrix.tencent.com/ai-detect/';
const EXT_ID = 'kdjgfockdecdbadmpbjgflmiffdiffhp';
const OBSERVE_MS = 30000;

const EDGE = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

// Installed before the page's own scripts. It does not change behaviour: it only keeps a reference
// to every socket the page creates, so the probe can close one and see what happens next.
const HOOK = `
    (() => {
        window.__zqSocketProbe = { created: [] };
        const Native = window.WebSocket;
        if (typeof Native !== 'function') return;

        const Wrapped = function (url, protocols) {
            const socket = protocols === undefined
                ? new Native(url)
                : new Native(url, protocols);
            window.__zqSocketProbe.created.push({ url: String(url), at: Date.now(), socket });
            return socket;
        };
        Wrapped.prototype = Native.prototype;
        Object.setPrototypeOf(Wrapped, Native);
        window.WebSocket = Wrapped;
    })();
`;

const results = { failed: false };
const say = text => console.log(text);

(async () => {
    const env = await launch({
        browser: EDGE,
        port: PORT,
        prefix: 'zqsocketprobe',
        args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
    });

    try {
        let worker = null;
        for (let i = 0; i < 40 && !worker; i += 1) {
            const targets = await httpJson(PORT, '/json/list');
            const sw = (targets || []).find(t => t.type === 'service_worker' && (t.url || '').includes(EXT_ID));
            if (sw) worker = await cdp(sw.webSocketDebuggerUrl);
            else await sleep(300);
        }
        if (!worker) { say('FAIL  the extension worker never started'); return; }
        say('ok    extension worker is up');

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
        if (!page) { results.failed = true; say('FAIL  the page never opened'); return; }

        const pageConn = await cdp(page.webSocketDebuggerUrl);
        const network = await cdp(page.webSocketDebuggerUrl);

        // The socket history, straight from the network stack.
        const opened = [];
        const closed = [];
        network.on(message => {
            if (message.method === 'Network.webSocketCreated') {
                opened.push({ requestId: message.params.requestId, url: message.params.url, at: Date.now() });
            }
            if (message.method === 'Network.webSocketClosed') {
                closed.push({ requestId: message.params.requestId, at: Date.now() });
            }
        });
        await network.send('Network.enable');

        // The hook has to be in place before the page's scripts run, so the page is reloaded once
        // after registering it. That is also what makes this a clean observation: everything that
        // happens afterwards is the page's own behaviour.
        await pageConn.send('Page.enable');
        await pageConn.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
        await pageConn.send('Page.reload', { ignoreCache: false });
        await sleep(6000);

        say('ok    page reloaded with the socket hook in place');

        const state = async expression => {
            const result = await pageConn.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
            return result.result ? result.result.value : undefined;
        };

        const seen = await state(`(() => {
            const probe = window.__zqSocketProbe;
            return probe ? probe.created.length : -1;
        })()`);
        say('ok    sockets the page created by itself: ' + seen);

        // Give the page a window to open one on its own, in case it is lazy about it.
        await sleep(4000);
        const beforeClose = opened.length;
        say('ok    sockets seen by the network stack before any close: ' + beforeClose);

        const closable = await state(`(() => {
            const probe = window.__zqSocketProbe;
            if (!probe || !probe.created.length) return null;
            // The most recent one is the one a detection would be using.
            const entry = probe.created[probe.created.length - 1];
            return { url: entry.url, index: probe.created.length - 1 };
        })()`);

        if (!closable) {
            say('note  the page opened no WebSocket on its own, so there was nothing to close');
            say('note  sockets on this site exist only during a detection, not on load');
        } else {
            say('ok    newest socket: ' + closable.url);

            const closedOk = await state(`(() => {
                const entry = window.__zqSocketProbe.created[${closable.index}];
                try {
                    entry.socket.close(4000, 'probe');
                    return true;
                } catch (e) {
                    return String(e);
                }
            })()`);
            if (closedOk !== true) results.failed = true;
            say((closedOk === true ? 'ok    ' : 'FAIL  ') + 'closed the newest socket: ' + String(closedOk));

            // This is the observation. A reconnect shows up as a new webSocketCreated, and a page
            // that reloads itself shows up as a new document, not as a socket.
            await sleep(OBSERVE_MS);

            const after = opened.length;
            const newOnes = opened.slice(beforeClose);
            say('ok    sockets seen ' + Math.round(OBSERVE_MS / 1000) + 's after the close: ' + after);
            say(newOnes.length
                ? 'RESULT  the site reconnected by itself (' + newOnes.length + ' new socket(s))'
                : 'RESULT  the site did not reconnect within ' + Math.round(OBSERVE_MS / 1000) + 's');

            // Whether the page threw itself away is a separate question: our reload would appear as
            // a new document with no user action.
            const navigations = await state(`(() => {
                const nav = performance.getEntriesByType('navigation')[0];
                return nav ? Math.round(performance.now()) : -1;
            })()`);
            say('note  document age at the end of the wait: ' + navigations + 'ms');
        }

        pageConn.close();
        network.close();
        worker.close();
    } finally {
        await env.cleanup();
    }

    console.log('\n' + (results.failed ? 'FAIL' : 'PASS') + ' socket reconnect observation');
})().catch(error => {
    process.stderr.write(`probe failed: ${error.message}\n`);
    process.exitCode = 1;
});
