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
    state: { enabled: true, rotating: false, autoRefresh: true },
    handlePageState(reason) { actions.push(reason); },
    send() {},
    noteContextError(error) { throw error; },
    ensureIdentity() { return null; },
    publishIdentity() {},
    startWatchdog() {},
    startAuto() {},
    signedIn() { return false; },
    currentState() { return {}; },
    reportState() {}
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
console.log('PASS: document_start before <html>, and mutations after it appears');
