// document_start is allowed to run before <html> exists. Observe Document, not documentElement.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../src/content/index.js'), 'utf8');
let observed = null;
let onMutate = null;
const actions = [];
const ZQ = {
    state: { enabled: true, rotating: false, autoRefresh: true, contextAlive: true },
    isAlive: () => ZQ.state.contextAlive,
    isEnabled: () => ZQ.isAlive() && ZQ.state.enabled,
    canAutoAct: () => ZQ.isEnabled() && ZQ.state.autoRefresh,
    canRotate: () => ZQ.canAutoAct() && !ZQ.state.rotating,
    handlePageState(reason) { actions.push(reason); },
    send() {},
    noteContextError(error) { throw error; },
    ensureIdentity() { return null; },
    publishIdentity() {},
    startWatchdog() {},
    startAuto() {},
    signedIn() { return false; },
    currentState() { return {}; },
    reportState() {},
    // The settings reader resolves the stored mode against these two, so a stub without them would
    // fail on a real call rather than on the thing under test (startup without <html>).
    SPENT_MODES: ['manual', 'press', 'delay'],
    DEFAULT_SPENT_DELAY_SECONDS: 2
};
const document = {
    documentElement: null,
    addEventListener() {}
};
const sandbox = {
    window: { __zq: ZQ },
    document,
    chrome: {
        runtime: { onMessage: { addListener() {} } },
        storage: {
            local: { get(keys, callback) { callback({ autoRefresh: true }); } },
            onChanged: { addListener() {} }
        }
    },
    MutationObserver: class {
        constructor(callback) { onMutate = callback; }
        observe(target, options) { observed = { target, options }; }
    }
};

vm.runInNewContext(source, sandbox, { filename: 'index.js' });
assert.equal(sandbox.window.__zqDetectReady, true, 'startup must finish without <html>');
assert.equal(observed.target, document, 'the observer must attach to Document');
assert.equal(observed.options.subtree, true, 'future root and descendants must be observed');
assert.equal(typeof onMutate, 'function');

// Mutations after the parser inserts <html> still reach the same observer.
document.documentElement = {};
onMutate();
assert.deepEqual(actions, ['quota']);

// The observer decides whether the page may act, and that decision is the one named in core.js.
// With the reload switch off the page is not acting on its own at all, so a mutation must not start
// a rotation attempt - which is what reading only `enabled` here used to do, once per mutation.
ZQ.state.autoRefresh = false;
onMutate();
assert.deepEqual(actions, ['quota'], 'a mutation must not act while the reload switch is off');

// Nor while a swap is already in flight.
ZQ.state.autoRefresh = true;
ZQ.state.rotating = true;
onMutate();
assert.deepEqual(actions, ['quota'], 'a mutation must not act while a swap is in flight');

// Switching the feature off does the same.
ZQ.state.rotating = false;
ZQ.state.enabled = false;
onMutate();
assert.deepEqual(actions, ['quota'], 'a mutation must not act while the feature is off');

// And all three back on: the page acts again.
ZQ.state.enabled = true;
onMutate();
assert.deepEqual(actions, ['quota', 'quota'], 'the page acts once every gate is open');

console.log('PASS: document_start before <html>, mutations after it, and the action gates');
