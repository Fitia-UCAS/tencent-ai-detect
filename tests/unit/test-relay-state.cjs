// The relay's online flag.
//
// Two modules learn whether the relay is up - the native host from what its child reports, the
// health probe from asking the port - and the panel reads a single stored value. This pins the two
// properties that make that value mean one thing: there is one writer, and "healthy" is one test.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = pathToFileURL(
    path.resolve(__dirname, '..', '..', 'src', 'background', 'relay-state.js')
).href;

const checks = [];
const check = (name, fn) => {
    try {
        fn();
        checks.push(true);
        console.log('  ok    ' + name);
    } catch (error) {
        checks.push(false);
        console.log('  FAIL  ' + name + ' - ' + error.message);
    }
};

function makeState() {
    const state = { online: false };
    const writes = [];
    const chrome = {
        storage: { local: { set(values) { writes.push(values); } } }
    };
    return { state, writes, chrome };
}

(async () => {
    const { createRelayState } = await import(MODULE);

    check('setting the flag records it in memory and in storage together', () => {
        const { state, writes, chrome } = makeState();
        const relayState = createRelayState({ chrome, state });

        assert.equal(relayState.set(true), true);
        assert.equal(state.online, true);
        assert.deepEqual(writes, [{ relayOnline: true }]);

        assert.equal(relayState.set(false), false);
        assert.equal(state.online, false);
        assert.deepEqual(writes, [{ relayOnline: true }, { relayOnline: false }]);
    });

    check('anything that is not true records as offline', () => {
        const { state, chrome } = makeState();
        const relayState = createRelayState({ chrome, state });

        for (const value of [undefined, null, 1, 'yes', {}, 0, false]) {
            relayState.set(value);
            assert.equal(state.online, false, JSON.stringify(value) + ' must not read as online');
        }
    });

    check('only an explicit ok:true counts as healthy', () => {
        const { state, chrome } = makeState();
        const relayState = createRelayState({ chrome, state });

        assert.equal(relayState.isHealthy({ ok: true }), true);
        for (const body of [null, undefined, {}, { ok: false }, { ok: 1 }, { ok: 'true' }, { ok: 0 }]) {
            assert.equal(relayState.isHealthy(body), false, JSON.stringify(body) + ' must not count');
        }
    });

    check('isOnline reflects the last write', () => {
        const { state, chrome } = makeState();
        const relayState = createRelayState({ chrome, state });

        assert.equal(relayState.isOnline(), false);
        relayState.set(true);
        assert.equal(relayState.isOnline(), true);
    });

    const failed = checks.filter(ok => !ok).length;
    console.log('');
    if (failed) {
        console.error(`${failed}/${checks.length} relay state checks failed`);
        process.exit(1);
    }
    console.log(`PASS: ${checks.length}/${checks.length} relay state checks`);
})();
