// Can a header be attached to the WebSocket handshake at all?
// declarativeNetRequest cannot do it; this checks whether CDP can, which is
// what the launcher-style tools rely on.
const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9336;
const SITE = 'https://matrix.tencent.com/ai-detect/';
const XFF = '112.90.44.17';

const { sleep, httpJson, cdp, launch, cleanupAll } = require('../browser-harness.cjs');

(async () => {
    const out = { wsHeaders: null, docHeaders: null, wsHasXff: false, error: null };
    let session = null;

    try {
        session = await launch({ browser: BROWSER, port: PORT, prefix: 'zqcdp' });

        const target = await httpJson(PORT, '/json/new?about:blank', 'PUT');
        const page = await cdp(target.webSocketDebuggerUrl);

        page.on(msg => {
            if (msg.method === 'Network.webSocketWillSendHandshakeRequest') {
                out.wsHeaders = msg.params.request.headers;
            }
            if (msg.method === 'Network.requestWillBeSentExtraInfo' && out.docHeaders === null) {
                const headers = msg.params.headers || {};
                if (Object.keys(headers).some(k => /forwarded/i.test(k))) out.docHeaders = headers;
            }
        });

        await page.send('Network.enable');
        await page.send('Page.enable');
        // Applies to every request the page makes, including the WS upgrade.
        await page.send('Network.setExtraHTTPHeaders', { headers: { 'X-Forwarded-For': XFF } });
        await page.send('Page.navigate', { url: SITE });

        const until = Date.now() + 30000;
        while (Date.now() < until && !out.wsHeaders) await sleep(400);

        page.close();
    } catch (e) {
        out.error = String(e && e.message ? e.message : e);
    } finally {
        if (session) await session.cleanup();
        await cleanupAll();
    }

    out.wsHasXff = !!(out.wsHeaders && Object.keys(out.wsHeaders).some(k => /forwarded/i.test(k)));
    console.log(JSON.stringify(out, null, 2));
})();
