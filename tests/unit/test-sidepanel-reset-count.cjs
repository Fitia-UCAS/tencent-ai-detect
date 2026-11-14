// Verifies that the side panel does not increment resetCount itself.
// The background process is the single source of truth because it records
// logReset only after the content script has entered the reset path.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeElement() {
    const listeners = new Map();
    const attributes = new Map();
    const classes = new Set();
    return {
        disabled: false,
        textContent: '',
        title: '',
        dataset: {},
        classList: {
            add(name) { classes.add(name); },
            remove(name) { classes.delete(name); },
            toggle(name, force) {
                if (force) classes.add(name);
                else classes.delete(name);
            }
        },
        addEventListener(type, listener) { listeners.set(type, listener); },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.get(name) ?? null; },
        click() {
            const listener = listeners.get('click');
            if (listener) listener({ target: this });
        }
    };
}

const elements = new Map([
    ['toggle-refresh', makeElement()],
    ['toggle-relay', makeElement()],
    ['reset-usage', makeElement()],
    ['open-site', makeElement()],
    ['page-state', makeElement()],
    ['notice', makeElement()]
]);
const writes = [];
const messages = [];
let domReady = null;

// The panel follows live page state through these events; the assertions below are about the
// reset path, so the events are inert here but must exist or the script throws on load.
const makeEvent = () => ({ addListener() {} });

const chrome = {
    sidePanel: { setPanelBehavior: () => Promise.resolve() },
    storage: {
        local: {
            get(_keys, callback) { callback({ autoRefresh: true, relayEnabled: true, resetCount: 4 }); },
            set(values, callback) {
                writes.push({ ...values });
                if (callback) callback();
            }
        },
        onChanged: makeEvent()
    },
    runtime: { lastError: undefined, sendMessage() {} },
    tabs: {
        query(_query, callback) { callback([{ id: 42 }]); },
        sendMessage(tabId, message, callback) {
            // The panel polls the active tab for its state on open; only the reset message matters here.
            if (message.action === 'getStatus') { callback({ status: 'ok' }); return; }
            messages.push({ tabId, ...message });
            callback({ status: 'success' });
        },
        create() {},
        onActivated: makeEvent(),
        onUpdated: makeEvent()
    }
};

const document = {
    addEventListener(type, listener) {
        if (type === 'DOMContentLoaded') domReady = listener;
    },
    getElementById(id) { return elements.get(id); }
};

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'sidepanel', 'index.js'), 'utf8');
vm.runInNewContext(source, {
    chrome,
    document,
    Date,
    Promise,
    setTimeout,
    clearTimeout,
    console
}, { filename: 'src/sidepanel/index.js' });

assert.equal(typeof domReady, 'function', 'side panel registers DOMContentLoaded');
domReady();
elements.get('reset-usage').click();

assert.deepEqual(messages, [{ tabId: 42, action: 'manualReset' }]);
assert.equal(elements.get('reset-usage').disabled, false);
assert.equal(
    writes.some(write => Object.hasOwn(write, 'resetCount')),
    false,
    'side panel must not increment resetCount in parallel with background logReset'
);
assert.equal(
    writes.some(write => Object.hasOwn(write, 'lastResetTime')),
    false,
    'side panel must not update reset timestamps independently'
);

process.stdout.write('PASS: side panel delegates reset accounting to background (4 assertions)\n');
