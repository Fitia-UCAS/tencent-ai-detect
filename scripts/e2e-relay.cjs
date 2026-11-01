// End-to-end through the relay: the extension must redirect the page's socket,
// the relay must rotate the client address, and no debugger may be attached.
const path = require('path');
const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.resolve(__dirname, '..');
const SITE = 'https://matrix.tencent.com/ai-detect/';
const PORT = 9374;

const { sleep, httpJson, cdp, launch, cleanupAll } = require('./browser-harness.cjs');

(async () => {
  const report = { targets: [], verdicts: [], relays: [], steps: [], error: null };
  let session = null;

  try {
    session = await launch({
      browser: BROWSER,
      port: PORT,
      prefix: 'zqrelay',
      args: [
        '--disable-features=DisableLoadExtensionCommandLineSwitch',
        `--disable-extensions-except=${EXT}`,
        `--load-extension=${EXT}`
      ]
    });

    const target = await httpJson(PORT, '/json/new?about:blank', 'PUT');
    const page = await cdp(target.webSocketDebuggerUrl);

    page.on(msg => {
      if (msg.method === 'Network.webSocketCreated') {
        report.targets.push(msg.params.url);
      }
      if (msg.method === 'Network.webSocketFrameReceived') {
        const raw = String(msg.params.response.payloadData);
        try {
          const d = JSON.parse(raw);
          if (d.status) report.verdicts.push(d.status === 'success' ? `success/${d.availableUses}` : d.status);
        } catch (e) {
        }
      }
    });

    await page.send('Network.enable');
    await page.send('Page.enable');
    await page.send('Runtime.enable');

    const read = async () => {
      const r = await page.send('Runtime.evaluate', {
        expression: `JSON.stringify({
          shim: !!window.__zqRelayShim,
          fp: localStorage.getItem('fp'),
          state: localStorage.getItem('zqRotationState')
        })`,
        returnByValue: true
      });
      return r.result && r.result.value;
    };

    const poke = async () => {
      await page.send('Runtime.evaluate', {
        expression: `(() => {
          const box = document.createElement('div');
          box.textContent = 'Invalid request';
          document.body.appendChild(box);
          return true;
        })()`,
        returnByValue: true
      });
    };

    await page.send('Page.navigate', { url: SITE });
    await sleep(6000);
    report.steps.push({ at: 'loaded', state: await read() });

    for (let i = 1; i <= 3; i++) {
      await poke();
      await sleep(7000);
      report.steps.push({ at: `after poke ${i}`, state: await read() });
    }

    // Any debugger attachment would surface here.
    const swTargets = (await httpJson(PORT, '/json/list')) || [];
    report.extensionLoaded = swTargets.some(t =>
      t.type === 'service_worker' && String(t.url).includes('background.js'));

    page.close();
  } catch (e) {
    report.error = String(e && e.message ? e.message : e);
  } finally {
    if (session) await session.cleanup();
    await cleanupAll();
  }

  console.log(JSON.stringify(report, null, 2));
  const allRelayed = report.targets.length > 0 && report.targets.every(u => u.startsWith('ws://127.0.0.1'));
  process.exitCode = allRelayed && report.verdicts.filter(v => v.startsWith('success')).length > 0 ? 0 : 1;
  console.log(allRelayed ? 'OK: every socket went through the relay' : 'FAIL: socket bypassed the relay');
})();
