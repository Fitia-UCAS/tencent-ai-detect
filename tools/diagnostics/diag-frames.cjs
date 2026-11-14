// Records the real WebSocket conversation with the detection endpoint.
//
// The site reports a bare "Invalid request" with no detail, so the only way to
// tell "the fingerprint was refused" from "the captcha ticket was refused" is to
// look at which frame the server rejected and what it replied to each one.
//
// This loads only the shim (no extension), so the relay is a plain local server
// and nothing else can interfere. It prints every frame in both directions.
const path = require('node:path');
const fs = require('node:fs');

const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9397;
const SITE = 'https://matrix.tencent.com/ai-detect/';

const { sleep, httpJson, cdp, launch } = require('../browser-harness.cjs');

const TAG = {
  fp: 'FP   ',
  ticket: 'TICKET',
  text: 'TEXT ',
  access: 'TOKEN'
};

// Frames carry JSON or a bare string; label them by shape so the output is
// readable without opening the messages.
function label(payload) {
  const raw = String(payload);

  if (/availableUses/.test(raw)) return 'USES ';
  if (/"ticket"/.test(raw)) return TAG.ticket;

  try {
    const parsed = JSON.parse(raw);

    if (parsed && typeof parsed === 'object') {
      if (parsed.fp) return TAG.fp;
      if (parsed.access_token) return TAG.access;
      if ('text' in parsed) return TAG.text;
      if (parsed.status) return 'STATUS';
    }
  } catch (e) {
  }

  return 'OTHER ';
}

function show(payload) {
  const raw = String(payload);

  // Long detection text would drown the log; keep the head and the length.
  return raw.length > 300 ? `${raw.slice(0, 260)}… (${raw.length} chars)` : raw;
}

(async () => {
  let session = null;

  try {
    session = await launch({ browser: BROWSER, port: PORT, prefix: 'zqframes' });

    const target = await httpJson(PORT, '/json/new?about:blank', 'PUT');
    const page = await cdp(target.webSocketDebuggerUrl);

    const shim = fs.readFileSync(path.join(__dirname, '..', '..', 'shim.js'), 'utf8');

    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Network.enable');
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: shim });

    const sent = [];
    const received = [];

    page.on(msg => {
      if (msg.method === 'Network.webSocketCreated') {
        process.stdout.write(`socket  ${msg.params.url}\n`);
      }

      if (msg.method === 'Network.webSocketFrameSent') {
        sent.push(msg.params.response.payloadData);
        process.stdout.write(`  SEND ${label(msg.params.response.payloadData)} ${show(msg.params.response.payloadData)}\n`);
      }

      if (msg.method === 'Network.webSocketFrameReceived') {
        received.push(msg.params.response.payloadData);
        process.stdout.write(`  RECV ${label(msg.params.response.payloadData)} ${show(msg.params.response.payloadData)}\n`);
      }

      if (msg.method === 'Network.webSocketClosed') {
        process.stdout.write('socket closed\n');
      }
    });

    await page.send('Page.navigate', { url: SITE });

    process.stdout.write('waiting for the site to open its socket and send the fingerprint frame...\n');

    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !received.length) await sleep(500);

    // Give the server a moment to answer anything else that follows.
    await sleep(4000);

    process.stdout.write(`\nframes: sent=${sent.length} received=${received.length}\n`);

    if (!sent.length) process.stdout.write('no frames sent: the shim did not take over, or the site never opened a socket\n');
  } catch (error) {
    process.stdout.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    if (session) await session.cleanup();
  }
})();
