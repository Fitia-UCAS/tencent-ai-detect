// Verifies that a disabled user switch survives an extension reload.
//
// IMPORTANT: chrome.runtime.reload() is NOT a genuine version upgrade. This
// test covers persistence after reload; a packaged version-to-version upgrade
// requires a separate test with two signed builds/profiles.
const path = require('node:path');

const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.resolve(__dirname, '..');
const EXT_ID = process.env.EXT_ID || 'kdjgfockdecdbadmpbjgflmiffdiffhp';
const PORT = 9383;
const RELAY_PORT = 9420;

const { sleep, httpJson, cdp, launch } = require('./browser-harness.cjs');
const { relayHealthy } = require('./test-relay.cjs');

const failures = [];
const ok = m => process.stdout.write(`  ok    ${m}\n`);
const fail = m => { failures.push(m); process.stdout.write(`  FAIL  ${m}\n`); };

async function waitFor(predicate, attempts = 40, gap = 400) {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return true;
    await sleep(gap);
  }
  return false;
}

(async () => {
  let session = null;
  let panel = null;

  try {
    if (await relayHealthy(RELAY_PORT)) {
      fail('a relay is already running; stop it first');
    } else {
      ok('no relay running before the test');

      session = await launch({
        browser: BROWSER,
        port: PORT,
        prefix: 'zqupdate',
        args: [
          '--disable-features=DisableLoadExtensionCommandLineSwitch',
          `--disable-extensions-except=${EXT}`,
          `--load-extension=${EXT}`
        ]
      });

      const started = await waitFor(() => relayHealthy(RELAY_PORT), 40, 500);
      started ? ok('relay started on first install') : fail('relay did not start on first install');

      const panelTarget = await httpJson(
        PORT,
        `/json/new?chrome-extension://${EXT_ID}/sidepanel.html`,
        'PUT'
      );

      if (!panelTarget || !panelTarget.webSocketDebuggerUrl) {
        fail('could not open the side panel page');
      } else {
        panel = await cdp(panelTarget.webSocketDebuggerUrl);
        await panel.send('Runtime.enable');
        await sleep(1000);

        const send = expression => panel.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true
        });

        // User switches the relay off.
        await send(`new Promise(r => chrome.runtime.sendMessage({ action: 'setRelay', enabled: false }, r))`);

        const offOk = await waitFor(async () => !(await relayHealthy(RELAY_PORT)), 30, 400);
        offOk ? ok('relay stopped after switching off') : fail('relay kept running after switching off');

        // Exercise an extension reload only. This does not simulate an
        // onInstalled(reason='update') event from a real version upgrade.
        await send(`chrome.runtime.reload(); 'reloading'`).catch(() => {});

        // Give the reload time to settle, then confirm nothing came back.
        await sleep(6000);

        if (await relayHealthy(RELAY_PORT)) {
          fail('relay came back after the extension reloaded, ignoring relayEnabled=false');
        } else {
          ok('relay stayed off across the reload');
        }

        panel.close();
        panel = null;
      }
    }
  } catch (e) {
    fail('exception: ' + String(e && e.message ? e.message : e));
  } finally {
    if (panel) panel.close();
    if (session) await session.cleanup();
  }

  if (failures.length) {
    process.stdout.write(`\n${failures.length} check(s) failed\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('\nall checks passed\n');
  }
})();
