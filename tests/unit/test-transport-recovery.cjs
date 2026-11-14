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
function load({ relayOk = false, enabled = true, alive = true, rotating = false, storage, getFails = false, setFails = false, silentWrite = false, noStorage = false } = {}) {
    // The reload budget lives in extension storage, so a test that spans a reload shares this map.
    // The page's own localStorage is present but deliberately irrelevant: the page owns it, so it
    // must not be able to influence the budget either way.
    const store = storage || new Map();
    const sends = [];
    const reports = [];
    const pageWrites = [];
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
            },
            // Absent entirely when the extension context is gone, which is one of the failure modes
            // the budget must fail closed on.
            storage: noStorage ? undefined : {
                local: {
                    get(keys, callback) {
                        if (getFails) throw new Error('storage read blocked');
                        setTimeout(() => {
                            const out = {};
                            for (const key of keys) {
                                if (store.has(key)) out[key] = store.get(key);
                            }
                            callback(out);
                        }, 0);
                    },
                    set(items, callback) {
                        if (setFails) throw new Error('storage write blocked');
                        setTimeout(() => {
                            // A write that is accepted but not persisted must not read back.
                            if (!silentWrite) {
                                for (const [key, value] of Object.entries(items)) store.set(key, value);
                            }
                            if (callback) callback();
                        }, 0);
                    }
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
        // Present so a path that wrote the budget into page-owned storage would be visible.
        localStorage: {
            getItem: () => null,
            setItem: key => pageWrites.push(key),
            removeItem: () => {}
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
            const record = store.get('zqTransportReloads');
            return record && typeof record === 'object' ? Number(record.count) || 0 : 0;
        },
        // Simulates a page script wiping its own origin's storage. It cannot reach the extension
        // store, which is the point.
        wipePageStorage: () => { pageWrites.length = 0; },
        pageStorageWrites: () => pageWrites.length,
        // Ages the stored record past the window, as a later page load would see it.
        expireBudget: () => {
            const record = store.get('zqTransportReloads');
            if (!record || typeof record !== 'object') return;
            store.set('zqTransportReloads', { count: record.count, at: Date.now() - 120000 });
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

check('the two-reload budget holds across three distinct page loads', async () => {
    const shared = new Map();
    const first = load({ relayOk: true, storage: shared });
    await first.announce();
    first.fireTimers();
    assert.equal(first.reloads.length, 1);

    const second = load({ relayOk: true, storage: shared });
    await second.announce();
    second.fireTimers();
    assert.equal(second.reloads.length, 1, 'the second reload is within the configured budget');
    assert.equal(second.stored(), 2);

    const third = load({ relayOk: true, storage: shared });
    await third.announce();
    third.fireTimers();
    assert.equal(third.reloads.length, 0, 'a new page load must not reset the budget');
    assert.deepEqual(third.statuses(), ['transport-failed']);
});

check('blocked storage reads report a failure without a reload', async () => {
    const page = load({ relayOk: true, getFails: true });
    await page.announce();
    page.fireTimers();
    assert.equal(page.reloads.length, 0);
    assert.deepEqual(page.statuses(), ['transport-failed']);
});

check('blocked storage writes report a failure without a reload', async () => {
    const page = load({ relayOk: true, setFails: true });
    await page.announce();
    page.fireTimers();
    assert.equal(page.reloads.length, 0);
    assert.deepEqual(page.statuses(), ['transport-failed']);
});

check('a missing extension storage fails closed', async () => {
    // The context can be gone (worker torn down, extension reloaded). Reading that as "no reloads
    // recorded yet" would restore exactly the per-load reset the budget exists to prevent.
    const page = load({ relayOk: true, noStorage: true });
    await page.announce();
    page.fireTimers();
    assert.equal(page.reloads.length, 0);
    assert.deepEqual(page.statuses(), ['transport-failed']);
});

check('the page cannot reset the budget through its own storage', async () => {
    const first = load({ relayOk: true });
    await first.announce();
    first.fireTimers();
    assert.equal(first.reloads.length, 1);
    assert.equal(first.stored(), 1, 'the budget is written where the page cannot reach it');
    assert.equal(first.pageStorageWrites(), 0, 'and nothing is written to page-owned storage');

    // A page script wiping its origin's storage cannot touch the record, so a third load still
    // has to respect the two-reload budget.
    const second = load({ relayOk: true, storage: first.storage });
    second.wipePageStorage();
    await second.announce();
    second.fireTimers();
    assert.equal(second.reloads.length, 1, 'the second reload is still within the budget');

    const third = load({ relayOk: true, storage: first.storage });
    third.wipePageStorage();
    await third.announce();
    third.fireTimers();
    assert.equal(third.reloads.length, 0, 'a wiped page storage must not refill the budget');
});

check('silently ignored storage writes do not permit a reload', async () => {
    const page = load({ relayOk: true, silentWrite: true });
    await page.announce();
    page.fireTimers();
    assert.equal(page.reloads.length, 0);
    assert.deepEqual(page.statuses(), ['transport-failed']);
});

check('corrupt reload records fail closed', async () => {
    const bad = [
        'not an object',
        { count: null, at: 1 },
        { count: -1, at: 1 },
        { count: 0, at: 1 },
        { count: 1, at: 0 },
        { count: 1.5, at: 1 },
        { at: Date.now() }
    ];

    for (const record of bad) {
        const page = load({ relayOk: true, storage: new Map([['zqTransportReloads', record]]) });
        await page.announce();
        page.fireTimers();
        assert.equal(page.reloads.length, 0, `record ${JSON.stringify(record)} must not permit a reload`);
        assert.deepEqual(page.statuses(), ['transport-failed']);
    }
});

check('a future reload timestamp is invalid rather than an expired budget', async () => {
    const future = { count: 1, at: Date.now() + 3600000 };
    const page = load({ relayOk: true, storage: new Map([['zqTransportReloads', future]]) });
    await page.announce();
    page.fireTimers();
    assert.equal(page.reloads.length, 0);
    assert.deepEqual(page.statuses(), ['transport-failed']);
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
