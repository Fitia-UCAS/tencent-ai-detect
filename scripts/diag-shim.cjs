// Isolated shim fallback test that cannot be rescued by the extension itself.
//
// The extension's worker revives the relay on an alarm, so any test that loads
// the extension will find a working relay a second later. This one loads only
// the shim into a page with the extension absent, using Page.addScriptToEvaluateOnNewDocument.
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');

const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9398;
const RELAY_PORT = 9420;
const SITE = 'https://matrix.tencent.com/ai-detect/';

const { sleep, httpJson, cdp, launch } = require('./browser-harness.cjs');

function relayUp() {
  return new Promise(resolve => {
    const s = net.connect(RELAY_PORT, '127.0.0.1');
    const done = ok => { s.destroy(); resolve(ok); };
    s.setTimeout(700);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

(async () => {
  let session = null;
  const failures = [];
  const ok = m => process.stdout.write(`  ok    ${m}\n`);
  const fail = m => { failures.push(m); process.stdout.write(`  FAIL  ${m}\n`); };

  async function runChecks() {
    // No --load-extension: the worker must not be able to revive the relay.
    session = await launch({ browser: BROWSER, port: PORT, prefix: 'zqfallback' });

    const target = await httpJson(PORT, '/json/new?about:blank', 'PUT');
    const page = await cdp(target.webSocketDebuggerUrl);

    const shim = fs.readFileSync(path.join(__dirname, '..', 'shim.js'), 'utf8');
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Network.enable');
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: shim });

    const sockets = [];
    const frames = [];
    page.on(msg => {
      if (msg.method === 'Network.webSocketCreated') sockets.push(msg.params.url);
      if (msg.method === 'Network.webSocketFrameReceived') {
        frames.push(String(msg.params.response.payloadData).slice(0, 120));
      }
    });

    await page.send('Page.navigate', { url: SITE });

    // The site opens its own socket on load; wait for the fallback to settle.
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline && !frames.length) await sleep(500);
    await sleep(1500);

    if (sockets.some(u => u.startsWith('ws://127.0.0.1'))) {
      ok('socket tried the relay first');
    } else {
      fail('socket never tried the relay');
    }

    if (sockets.some(u => u.includes('matrix.tencent.com'))) {
      ok('socket fell back to matrix.tencent.com');
    } else {
      fail('no fallback socket was created');
    }

    if (frames.some(f => f.includes('"status"'))) {
      ok(`server answered through the fallback (${frames[0]})`);
    } else {
      fail('server never answered through the fallback');
    }

    page.close();
  }

  try {
    if (await relayUp()) {
      // Do not return here: that would skip the failure summary at the bottom
      // and exit 0 while having asserted nothing.
      fail('port 9420 is already occupied; refusing to terminate an unknown process. Stop the test relay explicitly and rerun.');
    } else {
      ok('port 9420 is free');
      await runChecks();
    }
  } catch (e) {
    fail('exception: ' + String(e && e.message ? e.message : e));
  } finally {
    if (session) await session.cleanup();
  }

  if (failures.length) {
    process.stdout.write(`\n${failures.length} check(s) failed\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('\nall checks passed\n');
  }
})();
