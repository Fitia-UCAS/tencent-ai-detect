// A relay failure must not leave the page with a dead socket, and must not turn into a reload loop.
//
// The shim fails closed on purpose: opening the original endpoint would carry a different address
// than the one the captcha ticket was issued for. That leaves nothing in the page to open another
// socket, so the content script drives the recovery from the shim's announcement.
//
// engine.js installs its own relayReady/rotate/scheduleRetry, so the assertions here observe the
// seams it does not own - the messages it sends, the states it reports, and the timers it arms -
// rather than restubbing the functions under test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../../src/content/engine.js'), 'utf8');

// `relayOk` is what the worker answers to the health probe. `send` records every message so the
// recovery path can be read from the outside.
function load({ relayOk = false, enabled = true, alive = true, rotating = false, storage } = {}) {
    // The reload budget lives in localStorage, so a test that spans a reload has to share this map.
    const store = storage || new Map();
    const sends = [];
    const reports = [];
    const timers = new Map();
    const reloads = [];
    const listeners = new Map();
    let nextTimer = 1;

    const ZQ = {
        state: { enabled, autoRefresh: true, rotating, contextAlive: alive, retryTimer: null },
        // Constants the real module reads.
        CAPTCHA_WAIT_MS: 2000,
        RELAY_RETRY_MS: 2500,
        MIN_GAP_MS: 2500,
        USES_PER_IDENTITY: 4,
        WATCHDOG_MS: 2000,
        captchaOpen: () => false,
        signedIn: () => false,
        readState: () => ({ rotations: 0, failures: 0, backoffUntil: 0, lastRotationAt: 0, ip: null, transport: null }),
        writeState: patch => sends.push({ action: 'writeState', patch }),
        // engine.js installs its own currentState/reportState; those are observed through the
        // statusUpdate messages they send, so both stay as seams here.
        currentState: status => ({ status }),
        reportState: state => sends.push({ action: 'reportState', status: state.status }),
        send: message => {
            sends.push(message);
            return Promise.resolve(null);
        },
        clearFp: () => sends.push({ action: 'clearFp' }),
        readQuota: () => ({ remaining: 3, exhausted: false }),
        pageState: () => 'ok',
        identityUses: () => 0,
        noteContextError: () => {},
        handlePageState: () => {}
    };

    const sandbox = {
        chrome: {
            runtime: {
                lastError: null,
                sendMessage(message, callback) {
                    sends.push(message);
                    if (message && message.action === 'relayHealth') {
                        setTimeout(() => callback({ status: 'success', ok: relayOk, body: { ok: relayOk } }), 0);
                    }
                    return undefined;
                }
            }
        },
        window: {
            __zq: ZQ,
            addEventListener(type, fn) {
                listeners.set(type, fn);
            }
        },
        document: {},
        localStorage: {
            getItem: key => (store.has(key) ? store.get(key) : null),
            setItem: (key, value) => store.set(key, String(value)),
            removeItem: key => store.delete(key)
        },
        location: { reload: () => reloads.push(Date.now()) },
        setTimeout: fn => {
            const id = nextTimer++;
            timers.set(id, fn);
            return id;
        },
        clearTimeout: id => timers.delete(id),
        setInterval: () => 1,
        clearInterval: () => {},
        console
    };
    sandbox.window.window = sandbox.window;

    vm.runInNewContext(SOURCE, sandbox, { filename: 'engine.js' });

    return {
        ZQ, sends, reports, timers, reloads, listeners, storage: store,
        // What the stored reload budget currently says.
        stored: () => {
            const raw = store.get('zqTransportReloads');
            if (!raw) return 0;
            try {
                return Number(JSON.parse(raw).count) || 0;
            } catch (e) {
                return 0;
            }
        },
        // Ages the stored record past the window, as a later page load would see it.
        expireBudget: () => {
            const raw = store.get('zqTransportReloads');
            if (!raw) return;
            const record = JSON.parse(raw);
            record.at = Date.now() - 120000;
            store.set('zqTransportReloads', JSON.stringify(record));
        },
        // Lets the probe's queued callback run without firing the reload timers.
        settle: () => new Promise(resolve => setImmediate(resolve)),
        // The probe answers on a macrotask, and the rotation path probes again, so waiting a tick
        // of real time is what lets the whole nested chain settle before anything is asserted.
        announce: async () => {
            const result = listeners.get('zq:relay-failed')();
            await result;
            await new Promise(resolve => setTimeout(resolve, 20));
        },
        actions: () => sends.map(message => message.action),
        // Statuses reach the panel as statusUpdate messages; engine.js owns reportState.
        statuses: () => sends
            .filter(message => message.action === 'statusUpdate')
            .map(message => message.payload && message.payload.status),
        // Runs every armed timer so a scheduled reload actually happens.
        fireTimers: () => {
            const fns = [...timers.values()];
            timers.clear();
            for (const fn of fns) fn();
        }
    };
}

const checks = [];
const check = (name, run) => checks.push([name, run]);

check('engine subscribes to the shim announcement', async () => {
    const page = load();
    assert.equal(page.listeners.has('zq:relay-failed'), true);
});

check('a dead relay asks for a reconnect instead of reloading blind', async () => {
    const page = load({ relayOk: false });
    await page.announce();

    assert.ok(page.actions().includes('relayEnsure'),
        'the reconnect must be requested, or a reload cannot change the address either');
    assert.deepEqual(page.statuses(), ['relay-offline'],
        'the rotation path reports a dead relay rather than claiming a rotation happened');
    assert.equal(page.reloads.length, 0, 'no reload happens while the relay is still down');
});

check('the retry re-enters the rotation instead of reloading the page', async () => {
    const page = load({ relayOk: false });
    await page.announce();

    const before = page.actions().filter(action => action === 'relayEnsure').length;
    assert.ok(before >= 1, 'the reconnect must have been requested');

    page.fireTimers();
    await new Promise(resolve => setTimeout(resolve, 20));

    const after = page.actions().filter(action => action === 'relayEnsure').length;
    assert.ok(after > before, 'the rotation itself is retried once the timer fires');
    assert.equal(page.reloads.length, 0, 'a reload while the relay is down cannot change the address');
});

check('a live relay allows exactly one reload, then reports', async () => {
    const page = load({ relayOk: true });

    await page.announce();
    assert.deepEqual(page.statuses(), ['transport-failed'],
        'the failure is reported so the panel shows why the page went quiet');

    page.fireTimers();
    assert.equal(page.reloads.length, 1, 'one reload, so a fresh socket is opened');

    // A second failure in the same page load must not arm another reload.
    await page.announce();
    assert.deepEqual(page.statuses(), ['transport-failed', 'transport-failed']);
    page.fireTimers();
    assert.equal(page.reloads.length, 1, 'the retry is spent for this load');
});

check('the reload budget survives the reload it is bounding', async () => {
    // The counter is stored, so a reload cannot reset the budget. Without this, "one reload per
    // page load" allows one reload per load forever, which is exactly the loop it must prevent.
    const first = load({ relayOk: true });
    await first.announce();
    assert.equal(first.stored(), 1, 'the first reload is recorded outside the page');

    // The page reloads; a brand new instance starts with an empty in-memory flag but the same store.
    const second = load({ relayOk: true, storage: first.storage });
    await second.announce();

    assert.equal(second.reloads.length, 0, 'the budget is already spent, so no second reload');
    assert.deepEqual(second.statuses(), ['transport-failed'], 'the state is still reported');
});

check('the budget expires so a later failure can still recover', async () => {
    const first = load({ relayOk: true });
    await first.announce();
    first.expireBudget();

    const second = load({ relayOk: true, storage: first.storage });
    await second.announce();
    second.fireTimers();

    assert.equal(second.reloads.length, 1, 'a stale failure must not block recovery later');
});

check('a broken relay keeps reusing the rotation path instead of reloading', async () => {
    const page = load({ relayOk: false });

    await page.announce();
    await page.announce();
    await page.announce();

    assert.equal(page.reloads.length, 0, 'a reload cannot change the address while the relay is down');
    assert.ok(page.actions().filter(action => action === 'relayEnsure').length >= 3,
        'each failure asks for the relay again');
});

check('a disabled switch is left alone', async () => {
    const page = load({ relayOk: false, enabled: false });
    await page.announce();

    assert.equal(page.actions().includes('relayEnsure'), false);
    assert.deepEqual(page.statuses(), []);
});

check('a stale script does not act', async () => {
    const page = load({ relayOk: false, alive: false });
    await page.announce();

    assert.equal(page.actions().includes('relayEnsure'), false);
    assert.deepEqual(page.statuses(), []);
});

check('a rotation already in flight owns the recovery', async () => {
    const page = load({ relayOk: false, rotating: true });
    await page.announce();

    assert.equal(page.actions().includes('relayEnsure'), false);
    assert.deepEqual(page.statuses(), []);
});

(async () => {
    let failures = 0;

    for (const [name, run] of checks) {
        try {
            await run();
            console.log('  ok    ' + name);
        } catch (error) {
            failures += 1;
            console.error('  FAIL  ' + name + ': ' + error.message);
        }
    }

    console.log(`\n${failures ? 'FAIL' : 'PASS'}: ${checks.length - failures}/${checks.length} transport recovery checks`);
    if (failures) process.exitCode = 1;
})();
