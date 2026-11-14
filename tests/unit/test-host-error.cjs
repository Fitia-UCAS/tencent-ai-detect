// Verifies a native host that cannot start is reported rather than failing silently.
//
// The extension appeared to do nothing at all: the registry named a manifest that no longer
// existed, so the host could not start, and no surface anywhere said so. The browser signals this
// only as a disconnect immediately after connecting, so the module has to capture that reason and
// publish it; these cases pin both halves.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'src', 'background', 'native-host.js')
).href;

function makeEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) { listeners.push(listener); },
    dispatch(...args) { for (const listener of listeners) listener(...args); }
  };
}

// A chrome surface whose connectNative either throws or returns a port that disconnects, which is
// how the browser reports a host that is not registered.
function makeChrome(mode, message) {
  const writes = {};
  const port = {
    onMessage: makeEvent(),
    onDisconnect: makeEvent(),
    postMessage() {},
    disconnect() {}
  };

  const chrome = {
    runtime: {
      lastError: undefined,
      connectNative() {
        if (mode === 'throw') throw new Error(message);
        return port;
      }
    },
    storage: {
      local: {
        set(values) { Object.assign(writes, values); }
      }
    }
  };

  return { chrome, port, writes };
}

async function load() {
  return import(MODULE);
}

const checks = [];
const check = async (name, fn) => {
  try {
    await fn();
    checks.push(true);
    console.log('  ok    ' + name);
  } catch (error) {
    checks.push(false);
    console.log('  FAIL  ' + name + '  - ' + error.message);
  }
};

(async () => {
  const { createNativeHost } = await load();

  await check('a connect that throws is recorded and published', async () => {
    const { chrome, writes } = makeChrome('throw', 'Specified native messaging host not found.');
    const state = { port: null, online: false, hostError: null };
    const host = createNativeHost({ chrome, hostName: 'nope', state });

    assert.equal(host.ensure(), null, 'no port means no connection');
    assert.equal(state.hostError, 'Specified native messaging host not found.');
    assert.equal(writes.hostError, 'Specified native messaging host not found.');
  });

  // The browser's real signal: the port is created, then disconnects with lastError set.
  await check('a disconnect with lastError is recorded and published', async () => {
    const { chrome, port, writes } = makeChrome('port');
    const state = { port: null, online: false, hostError: null };
    const host = createNativeHost({ chrome, hostName: 'host', state });

    host.ensure();
    assert.equal(writes.hostError, undefined, 'nothing is wrong until the port drops');

    chrome.runtime.lastError = { message: 'Specified native messaging host not found.' };
    port.onDisconnect.dispatch();
    chrome.runtime.lastError = undefined;

    assert.equal(state.hostError, 'Specified native messaging host not found.');
    assert.equal(writes.hostError, 'Specified native messaging host not found.');
    assert.equal(writes.relayOnline, false);
  });

  // Once the host answers, the registration is proven good and the banner must clear.
  await check('a relay message clears the recorded failure', async () => {
    const { chrome, port, writes } = makeChrome('port');
    const state = { port: null, online: false, hostError: null };
    const host = createNativeHost({ chrome, hostName: 'host', state });

    host.ensure();
    chrome.runtime.lastError = { message: 'not found' };
    port.onDisconnect.dispatch();
    chrome.runtime.lastError = undefined;
    assert.ok(state.hostError);

    // Reconnect and let the host answer.
    host.ensure();
    port.onMessage.dispatch({ type: 'relay', ok: true, reused: false });

    assert.equal(state.hostError, null, 'a working host means no error');
    assert.equal(writes.hostError, null, 'the stale error is cleared in storage too');
    assert.equal(writes.relayOnline, true);
  });

  // A repeated identical failure must not rewrite storage on every attempt.
  await check('the same failure is not republished on each retry', async () => {
    const { chrome } = makeChrome('throw', 'Specified native messaging host not found.');
    const state = { port: null, online: false, hostError: null };

    let writes = 0;
    const counted = {
      ...chrome,
      storage: { local: { set() { writes += 1; } } }
    };

    const host = createNativeHost({ chrome: counted, hostName: 'nope', state });
    host.ensure();
    host.ensure();
    host.ensure();

    assert.equal(writes, 1, 'expected one write, got ' + writes);
  });

  // A stale port disconnecting after a new one replaced it must not mark the live host broken.
  await check('a replaced port disconnecting does not record a failure', async () => {
    const { chrome, port } = makeChrome('port');
    const state = { port: null, online: false, hostError: null };
    const host = createNativeHost({ chrome, hostName: 'host', state });

    host.ensure();
    const replaced = state.port;
    assert.ok(replaced);

    // Simulate a newer port taking over, then the old one dropping.
    state.port = { fake: true };
    chrome.runtime.lastError = { message: 'stale disconnect' };
    port.onDisconnect.dispatch();
    chrome.runtime.lastError = undefined;

    assert.equal(state.hostError, null, 'the live port is unaffected');
  });

  const failed = checks.filter(ok => !ok).length;
  console.log('');
  if (failed) {
    console.error(`${failed}/${checks.length} native host error checks failed`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${checks.length}/${checks.length} native host error checks`);
  }
})();
