// Verifies a page that already shows an exhausted allowance rotates without any user action.
//
// The only triggers were a DOM mutation and a click on the detect button. A page that loads
// already showing the exhausted wording and then sits still produces neither, so the rotation
// never fires - which is the common case, because the user opens the page after the allowance is
// spent. These cases pin both halves: the gap that caused it, and the watchdog that closes it.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CONTENT_DIR = path.join(__dirname, '..', '..', 'src', 'content');
// engine.js is loaded on its own for the unit-level checks, and all four files for the wiring
// check: whether index.js actually starts the watchdog is a separate question from whether the
// watchdog works.
const FILES = ['core.js', 'identity.js', 'detection.js', 'engine.js'];
const ALL_FILES = ['core.js', 'identity.js', 'detection.js', 'engine.js', 'index.js'];

// Builds the content namespace over a given page text. Rotations are counted through the storage
// record the engine writes, so no network or chrome surface is involved. Timers are tracked so the
// interval started by index.js cannot keep the process alive after a case finishes.
function load(bodyText, files = FILES) {
  const store = new Map();
  const sent = [];
  const intervals = new Set();

  const sandbox = {
    // The captcha predicate asks the DOM whether a challenge is on screen. No challenge exists in
    // these fixtures, so the lookups answer null and the measurements stay at a real viewport.
    window: {
      innerWidth: 1028,
      innerHeight: 754,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
    },
    document: {
      body: { innerText: bodyText },
      documentElement: { clientWidth: 1028, clientHeight: 754 },
      getElementById() { return null; },
      querySelector() { return null; },
      addEventListener() {},
      querySelectorAll() { return []; },
      cookie: ''
    },
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: key => store.delete(key)
    },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    location: { href: 'https://matrix.tencent.com/ai-detect/', reload() {} },
    chrome: {
      runtime: {
        lastError: undefined,
        // The relay answers healthy, so a rotation that starts will complete. The callback form is
        // what the engine actually uses; returning a promise alone leaves the probe waiting for its
        // timeout.
        sendMessage(message, callback) {
          sent.push(message);
          if (message.action === 'relayHealth') {
            if (typeof callback === 'function') callback({ ok: true });
            return Promise.resolve({ ok: true });
          }
          if (typeof callback === 'function') callback({ status: 'success' });
          return Promise.resolve({ status: 'success' });
        },
        onMessage: { addListener() {} }
      },
      storage: { local: { get() {}, set() {} }, onChanged: { addListener() {} } }
    },
    MutationObserver: function () { this.observe = () => {}; },
    setTimeout,
    clearTimeout,
    setInterval(fn, ms) {
      const handle = setInterval(fn, ms);
      intervals.add(handle);
      return handle;
    },
    clearInterval(handle) {
      intervals.delete(handle);
      return clearInterval(handle);
    },
    console, Date, Promise
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const name of files) {
    vm.runInContext(fs.readFileSync(path.join(CONTENT_DIR, name), 'utf8'), sandbox, {
      filename: 'src/content/' + name
    });
  }

  return {
    zq: sandbox.window.__zq,
    sent,
    // Clears every interval the content script started, so the process can exit.
    dispose() {
      for (const handle of intervals) clearInterval(handle);
      intervals.clear();
    },
    rotations: () => {
      const raw = store.get('zqRotationState');
      return raw ? (JSON.parse(raw).rotations || 0) : 0;
    }
  };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [];
const check = async (name, fn) => {
  let app = null;
  try {
    await fn(created => { app = created; return created; });
    checks.push(true);
    console.log('  ok    ' + name);
  } catch (error) {
    checks.push(false);
    console.log('  FAIL  ' + name + ' - ' + error.message);
  } finally {
    if (app) app.dispose();
  }
};

(async () => {
  const EXHAUSTED = '\u4e0a\u4f20 \u6e05\u7a7a \u4eca\u65e5\u6b21\u6570\u5df2\u7528\u5b8c \u8d5e/\u8e29\u53ef\u83b7\u53d6\u5956\u52b1\u6b21\u6570';

  // The gap: with no user action and no DOM change, nothing asks the page to rotate.
  await check('a static exhausted page does not rotate without a watchdog', async track => {
    const app = track(load(EXHAUSTED));
    await wait(120);
    assert.equal(app.rotations(), 0, 'nothing should have rotated yet');
    assert.equal(app.sent.filter(m => m.action === 'relayHealth').length, 0);
  });

  // The watchdog asks on its own, and the rotation actually starts.
  await check('the watchdog starts a rotation on a static exhausted page', async track => {
    const app = track(load(EXHAUSTED));
    assert.equal(typeof app.zq.startWatchdog, 'function', 'engine must expose startWatchdog');
    const stop = app.zq.startWatchdog(40);
    await wait(200);
    stop();
    assert.ok(app.rotations() >= 1, 'a rotation should have been recorded, got ' + app.rotations());
    assert.ok(
      app.sent.some(m => m.action === 'logReset'),
      'the rotation should have reported a reset'
    );
  });

  // A page with allowance must be left alone: rotating there would burn the allowance it has.
  await check('the watchdog leaves a page with allowance untouched', async track => {
    const app = track(load('\u4e0a\u4f20 \u6e05\u7a7a \u7acb\u5373\u68c0\u6d4b(\u4eca\u65e5\u5269\u4f595\u6b21)'));
    const stop = app.zq.startWatchdog(40);
    await wait(200);
    stop();
    assert.equal(app.rotations(), 0, 'no rotation should happen while allowance remains');
  });

  // A captcha failure is the user's to solve; rotation cannot fix it and would only reload.
  await check('the watchdog does not rotate on a captcha failure', async track => {
    const app = track(load('\u9a8c\u8bc1\u5931\u8d25\uff0c\u8bf7\u5b8c\u6210\u9a8c\u8bc1'));
    const stop = app.zq.startWatchdog(40);
    await wait(200);
    stop();
    assert.equal(app.rotations(), 0);
  });

  // Repeated ticks must not stack rotations: the engine refuses while one is in flight, and the
  // gap limit keeps a second one from firing immediately after.
  await check('repeated ticks do not stack rotations', async track => {
    const app = track(load(EXHAUSTED));
    const stop = app.zq.startWatchdog(20);
    await wait(300);
    stop();
    assert.ok(app.rotations() >= 1, 'expected at least one rotation');
    assert.ok(app.rotations() <= 2, 'expected at most two, got ' + app.rotations());
  });

  // Stopping the watchdog must actually stop it, or a dead context keeps scheduling reloads.
  await check('stopping the watchdog stops further checks', async track => {
    const app = track(load(EXHAUSTED));
    const stop = app.zq.startWatchdog(30);
    stop();
    await wait(150);
    assert.equal(app.rotations(), 0);
  });

  // The wiring: index.js must start the watchdog by itself. Without this the engine could be
  // correct and still never run, which is how the gap survived a passing test suite.
  await check('index.js starts the watchdog without being asked', async track => {
    const app = track(load(EXHAUSTED, ALL_FILES));
    await wait(6000);
    assert.ok(app.rotations() >= 1, 'the shipped wiring should have rotated, got ' + app.rotations());
  });

  const failed = checks.filter(ok => !ok).length;
  console.log('');
  if (failed) {
    console.error(`${failed}/${checks.length} auto-rotation checks failed`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${checks.length}/${checks.length} auto-rotation checks`);
  }
})();
