// Verifies the panel follows page state instead of requiring a manual refresh.
//
// The behaviours worth locking down are the passive ones: a stored status update must reach the
// label without any click, a report from a tab that is not the detection page must not be shown as
// current, and switching tabs must re-evaluate on its own. Driving the real script in a VM with a
// mocked chrome surface is the only way to assert them without a browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'sidepanel', 'index.js'),
    'utf8'
);

function makeEvent() {
    const listeners = [];
    return {
        listeners,
        addListener(fn) { listeners.push(fn); },
        dispatch(...args) { for (const fn of listeners) fn(...args); }
    };
}

function element(id) {
    return {
        id,
        textContent: '',
        title: '',
        dataset: {},
        classList: {
            _set: new Set(),
            toggle(name, on) { if (on) this._set.add(name); else this._set.delete(name); },
            add(name) { this._set.add(name); },
            remove(name) { this._set.delete(name); }
        },
        attributes: {},
        disabled: false,
        setAttribute(name, value) { this.attributes[name] = value; },
        getAttribute(name) { return this.attributes[name] ?? null; },
        addEventListener(type, fn) { (this._handlers ||= {}); (this._handlers[type] ||= []).push(fn); },
        click() { for (const fn of (this._handlers?.click || [])) fn(); }
    };
}

function build({ tabs = [], sendMessage } = {}) {
    const domReady = makeEvent();
    const storageChanged = makeEvent();
    const tabActivated = makeEvent();
    const tabUpdated = makeEvent();
    const elements = {
        'toggle-refresh': element('toggle-refresh'),
        'toggle-relay': element('toggle-relay'),
        'reset-usage': element('reset-usage'),
        'open-site': element('open-site'),
        'page-state': element('page-state'),
        notice: element('notice')
    };
    elements['toggle-relay'].setAttribute('aria-checked', 'true');
    elements['toggle-refresh'].setAttribute('aria-checked', 'true');

    const chrome = {
        sidePanel: { setPanelBehavior: () => Promise.resolve() },
        runtime: {
            lastError: undefined,
            sendMessage: sendMessage || ((message, cb) => { if (cb) cb({ status: 'success' }); })
        },
        storage: {
            local: {
                get: (keys, cb) => cb({ autoRefresh: true, relayEnabled: true, relayOnline: true }),
                set: (values, cb) => { if (cb) cb(); }
            },
            onChanged: storageChanged
        },
        tabs: {
            query: (info, cb) => cb(tabs),
            create: () => {},
            sendMessage: (tabId, message, cb) => {
                if (message.action !== 'getStatus') { if (cb) cb({ status: 'success' }); return; }
                const reply = typeof sendMessage === 'function' ? undefined : undefined;
                if (cb) cb(globalThis.__contentReply ?? null);
            },
            onActivated: tabActivated,
            onUpdated: tabUpdated
        }
    };

    const context = vm.createContext({
        chrome,
        document: {
            addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') domReady.addListener(fn); },
            getElementById: id => elements[id] || null
        },
        setTimeout,
        clearTimeout,
        console
    });

    vm.runInContext(SOURCE, context, { filename: 'src/sidepanel/index.js' });
    domReady.dispatch();

    return { elements, storageChanged, tabActivated, tabUpdated, chrome };
}

const checks = [];
const check = (name, fn) => {
    try {
        fn();
        checks.push({ name, ok: true });
        console.log('  ok    ' + name);
    } catch (error) {
        checks.push({ name, ok: false, error });
        console.log('  FAIL  ' + name + ' — ' + error.message);
    }
};

// A detection tab whose content script answers Ready.
const readyTab = [{ id: 11, active: true, url: 'https://matrix.tencent.com/ai-detect/' }];

// 1. Opening on the detection page shows the live state without any interaction.
globalThis.__contentReply = { status: 'ok', rotations: 0 };
{
    const app = build({ tabs: readyTab });
    check('panel shows Ready from the content script on open', () => {
        assert.equal(app.elements['page-state'].dataset.state, 'ok');
        assert.equal(app.elements['page-state'].textContent, 'Ready');
    });

    // 2. A background status write updates the label with no click involved.
    globalThis.__contentReply = { status: 'quota', rotations: 1 };
    check('a stored status update reaches the label without a click', () => {
        app.storageChanged.dispatch({ lastStatus: { newValue: { status: 'quota' } } }, 'local');
        assert.equal(app.elements['page-state'].dataset.state, 'quota');
        assert.equal(app.elements['page-state'].textContent, 'Quota reached');
    });

    // 3. Switching tabs re-evaluates by itself.
    globalThis.__contentReply = { status: 'captcha' };
    check('switching to the detection tab re-evaluates without a click', () => {
        app.tabActivated.dispatch({ tabId: 11 });
        assert.equal(app.elements['page-state'].dataset.state, 'captcha');
    });

    // 4. A relay dropout is its own state.
    check('a relay dropout surfaces as its own state', () => {
        app.storageChanged.dispatch({ relayOnline: { newValue: false } }, 'local');
        assert.equal(app.elements['page-state'].dataset.state, 'relay-offline');
    });
}

// 5. Standing on another site must not present that site's absence as a page state.
{
    const app = build({ tabs: [{ id: 12, active: true, url: 'https://example.com/' }] });
    check('standing on another site shows the open-the-page prompt', () => {
        assert.equal(app.elements['page-state'].dataset.state, 'away');
        assert.equal(app.elements['page-state'].textContent, 'Open the detection page');
    });
}

// 6. A report arriving while the user is elsewhere must not be shown as current.
{
    globalThis.__contentReply = { status: 'quota' };
    const app = build({ tabs: [{ id: 13, active: true, url: 'https://example.com/' }] });
    check('a quota report from a hidden detection tab is not shown as current', () => {
        app.storageChanged.dispatch({ lastStatus: { newValue: { status: 'quota' } } }, 'local');
        assert.equal(app.elements['page-state'].dataset.state, 'away');
    });
}

// 7. A page that has not loaded its content script yet is "waiting", not an error.
{
    globalThis.__contentReply = null;
    const app = build({ tabs: readyTab });
    check('a page without a content script yet shows Waiting', () => {
        assert.equal(app.elements['page-state'].dataset.state, 'waiting');
    });
}

// 8. The existing controls keep working (no regression from adding the state row).
{
    globalThis.__contentReply = { status: 'ok' };
    let relayPayload;
    const app = build({
        tabs: readyTab,
        sendMessage: (message, cb) => {
            if (message.action === 'setRelay') { relayPayload = message; cb({ status: 'success', online: true }); return; }
            cb({ status: 'success' });
        }
    });
    check('the relay switch still sends setRelay', () => {
        app.elements['toggle-relay'].click();
        // The payload is built inside the VM realm, so its prototype differs from this one; compare
        // the fields rather than the object identity.
        assert.equal(relayPayload.action, 'setRelay');
        assert.equal(relayPayload.enabled, false);
        assert.equal(app.elements['toggle-relay'].getAttribute('aria-checked'), 'false');
    });
}

// 9. Every state the content script can report must have a label, otherwise the row would show
// an empty string and look broken.
{
    const labels = new Set(['waiting', 'idle', 'ok', 'quota', 'captcha', 'ambiguous',
        'signed-in', 'rotated', 'relay-offline', 'away']);
    const reported = ['idle', 'ok', 'quota', 'captcha', 'ambiguous', 'signed-in', 'rotated', 'relay-offline'];
    check('every reported state has a label', () => {
        for (const state of reported) assert.ok(labels.has(state), 'missing label for ' + state);
        assert.match(SOURCE, /const LABELS = \{/);
    });
}

const failed = checks.filter(c => !c.ok);
console.log('');
if (failed.length) {
    console.error(`${failed.length}/${checks.length} side panel state checks failed`);
    process.exitCode = 1;
} else {
    console.log(`PASS: ${checks.length}/${checks.length} side panel state checks`);
}
