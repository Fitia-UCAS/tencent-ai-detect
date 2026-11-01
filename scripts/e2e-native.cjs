// Verifies the native-messaging lifecycle in a real browser, driving the switch
// through the side panel page so the real message path is exercised.
//
// Asserts four stages: the relay starts with the extension, the switch stops it,
// the switch restarts it, and closing the browser leaves nothing behind.
//
// No process is killed by name: the relay is detected by its health endpoint, so
// an unrelated Node program is never touched.
const path = require('node:path');

const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.resolve(__dirname, '..');
const EXT_ID = process.env.EXT_ID || 'kdjgfockdecdbadmpbjgflmiffdiffhp';
const PORT = 9382;
const RELAY_PORT = 9420;

const { sleep, httpJson, cdp, launch } = require('./browser-harness.cjs');
const { relayHealthy } = require('./test-relay.cjs');
const { ownedByOtherBrowser, browserOwning } = require('./relay-owner.cjs');
const { relayPidForPort } = require('./find-relay-pid.cjs');

const failures = [];
const ok = m => process.stdout.write(`  ok    ${m}\n`);
const fail = m => { failures.push(m); process.stdout.write(`  FAIL  ${m}\n`); };
// Not a pass and not a failure: the assertion cannot be evaluated because another browser
// owns the relay. Reported separately so it is never mistaken for verified behaviour.
const note = m => process.stdout.write(`  note  ${m}\n`);

const relayUp = () => relayHealthy(RELAY_PORT);

// Whether the running relay belongs to a browser other than this test's profile.
//
// The switch assertions below only mean something for a relay this test's browser owns: when
// another Edge window has the extension loaded, flipping the switch closes *this* browser's
// native port, but that window's keepalive brings the port straight back, and the relay that
// answers is not the one under test.
function relayOwnedElsewhere(profile) {
  if (!profile) return { other: false, known: false };

  const pid = relayPidForPort(RELAY_PORT);
  if (!pid) return { other: false, known: false };

  return ownedByOtherBrowser(pid, profile);
}

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
  let testProfile = null;

  try {
    if (await relayUp()) {
      const pid = relayPidForPort(RELAY_PORT);
      const owner = pid ? browserOwning(pid) : null;
      const who = owner
        ? ` It belongs to ${owner.name} pid ${owner.pid}` +
          (owner.profile ? ` (profile ${owner.profile}).` : ' (no --user-data-dir, so a normal browser window).')
        : '';
      fail(`a relay is already running on ${RELAY_PORT}; stop it first so the test owns the lifecycle.${who}`);
      note('close that browser or disable the extension in it and re-run: the port is hard-coded, so this test cannot pick another one');
    } else {
      ok('no relay running before the test');

      session = await launch({
        browser: BROWSER,
        port: PORT,
        prefix: 'zqnative',
        args: [
          '--disable-features=DisableLoadExtensionCommandLineSwitch',
          `--disable-extensions-except=${EXT}`,
          `--load-extension=${EXT}`
        ]
      });
      testProfile = session.profile;

      // 1. The relay must come up on its own, driven by the worker.
      const started = await waitFor(relayUp, 40, 500);
      started ? ok('relay started with the extension') : fail('relay did not start with the extension');

      // The side panel is a normal extension page, so it can message the worker
      // exactly like the real UI does.
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
        await panel.send('Page.enable');
        await panel.send('Page.bringToFront');

        const evaluate = async expression => {
          const result = await panel.send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true
          });
          if (result.exceptionDetails) {
            throw new Error('extension page evaluate failed: ' + result.exceptionDetails.text);
          }
          return result.result && result.result.value;
        };

        const switchState = async () => {
          const value = await evaluate(`(async () => {
            const button = document.getElementById('toggle-relay');
            const settings = await chrome.storage.local.get(['relayEnabled']);
            return JSON.stringify({
              found: !!button,
              checked: button?.getAttribute('aria-checked'),
              disabled: !!button?.disabled,
              saved: settings.relayEnabled !== false
            });
          })()`);
          return JSON.parse(value || '{}');
        };

        // Dispatch browser input to the actual switch instead of calling
        // chrome.runtime.sendMessage directly. This exercises sidepanel.js.
        const clickSwitch = async () => {
          const center = await evaluate(`(() => {
            const button = document.getElementById('toggle-relay');
            if (!button) return null;
            const rect = button.getBoundingClientRect();
            return JSON.stringify({ x: rect.left + rect.width / 2,
                                    y: rect.top + rect.height / 2 });
          })()`);
          if (!center) throw new Error('Relay switch element not found');
          const { x, y } = JSON.parse(center);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new Error('invalid Relay switch coordinates');
          }
          await panel.send('Input.dispatchMouseEvent', {
            type: 'mousePressed', x, y, button: 'left', clickCount: 1
          });
          await panel.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x, y, button: 'left', clickCount: 1
          });
        };

        const ready = await waitFor(async () => {
          const state = await switchState();
          return state.found && !state.disabled && state.checked === String(state.saved);
        }, 30, 200);
        if (!ready) throw new Error('side panel switch did not initialize');

        // 2. Click the actual UI control, then check both the persisted value
        // and the visual state. Port disappearance alone is insufficient.
        await clickSwitch();
        const offUi = await waitFor(async () => {
          const state = await switchState();
          return state.checked === 'false' && state.saved === false && !state.disabled;
        }, 40, 200);
        const offProcess = await waitFor(async () => !(await relayUp()), 30, 400);
        // When another browser owns the port, "still up" says nothing about this switch.
        const offOwner = offProcess ? { other: false } : relayOwnedElsewhere(testProfile);
        if (offUi && offProcess) {
          ok('Relay switch click disabled setting and stopped the process');
        } else if (offUi && offOwner.other) {
          note(
            `switch turned off and persisted, but the relay on ${RELAY_PORT} belongs to another browser ` +
            `(pid ${offOwner.owner.pid}, profile ${offOwner.owner.profile}); stop assertion not evaluable`
          );
        } else {
          fail(`Relay OFF failed: ui=${offUi} process=${offProcess}`);
        }

        // 3. Re-enable using the same on-screen switch and assert persistence.
        await clickSwitch();
        const onUi = await waitFor(async () => {
          const state = await switchState();
          return state.checked === 'true' && state.saved === true && !state.disabled;
        }, 40, 200);
        const onProcess = await waitFor(relayUp, 40, 500);
        onUi && onProcess
          ? ok('Relay switch click enabled setting and started the process')
          : fail(`Relay ON failed: ui=${onUi} process=${onProcess}`);

        panel.close();
        panel = null;
      }
    }
  } catch (e) {
    fail('exception: ' + String(e && e.message ? e.message : e));
  } finally {
    if (panel) panel.close();
    if (session) {
      await session.cleanup();

      // 4. Closing the browser closes the native messaging pipe; nothing may be
      //    left listening afterwards.
      const gone = await waitFor(async () => !(await relayUp()), 30, 200);
      if (gone) {
        ok('relay gone after the browser closed');
      } else {
        const owner = relayOwnedElsewhere(testProfile);
        owner.other
          ? note(
              `a relay is still listening, but it belongs to another browser ` +
              `(pid ${owner.owner.pid}, profile ${owner.owner.profile}); nothing this test started survived`
            )
          : fail('relay outlived the browser');
      }
    }
  }

  if (failures.length) {
    process.stdout.write(`\n${failures.length} check(s) failed\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('\nall checks passed\n');
  }
})();
