// The panel's one way to ask for another address.
//
// It used to have two: `rotate-now` and `reset-usage`. They were not two abilities. `rotateNow` calls
// forceRotate, `manualReset` cleared the failure counters and then called rotate - so the second
// button did the first one's job after some bookkeeping, and pressing it on a healthy page did
// nothing the first button would not have done. Two buttons that do one thing invite a wrong choice.
//
// This file pins the single remaining control: it asks the page to rotate, it guards against a
// second press while the round trip is in flight, and it cannot stay stuck.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'sidepanel', 'index.js'), 'utf8');

function makeEvent() {
    const listeners = [];
    return {
        addListener(fn) { listeners.push(fn); },
        dispatch(...args) { for (const fn of listeners) fn(...args); }
    };
}

function makeElement() {
    return {
        textContent: '',
        hidden: false,
        disabled: false,
        value: '',
        dataset: {},
        attributes: {},
        classList: { add() {}, remove() {}, toggle() {} },
        setAttribute(name, value) { this.attributes[name] = value; },
        getAttribute(name) { return this.attributes[name] ?? null; },
        addEventListener(type, fn) { (this._handlers ||= {}); (this._handlers[type] ||= []).push(fn); },
        click() { for (const fn of (this._handlers?.click || [])) fn(); }
    };
}

function build({ tabUrl = 'https://matrix.tencent.com/ai-detect/', sendFails = false } = {}) {
    const domReady = makeEvent();
    const elements = new Map([
        ['notice', makeElement()],
        ['host-alert', makeElement()],
        ['host-alert-detail', makeElement()],
        ['spent-delay', makeElement()],
        ['spent-delay-hint', makeElement()],
        ['rotate-now', makeElement()]
    ]);

    const sent = [];
    const tab = { id: 42, url: tabUrl };

    const card = makeElement();
    card.dataset.mode = 'manual';
    card.querySelector = () => makeElement();

    const chrome = {
        sidePanel: { setPanelBehavior: () => Promise.resolve() },
        runtime: { lastError: sendFails ? { message: 'no receiver' } : undefined },
        storage: {
            local: {
                get: (keys, cb) => cb({}),
                set: (values, cb) => { if (cb) cb(); }
            },
            onChanged: makeEvent()
        },
        tabs: {
            query: (info, cb) => cb([tab]),
            sendMessage: (tabId, message, cb) => {
                sent.push({ tabId, action: message.action });
                if (cb) cb(sendFails ? undefined : { status: 'success' });
            },
            onActivated: makeEvent(),
            onUpdated: makeEvent()
        }
    };

    const context = vm.createContext({
        chrome,
        document: {
            addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') domReady.addListener(fn); },
            getElementById: id => elements.get(id) || null,
            querySelectorAll: selector => selector === '.spent-card' ? [card] : []
        },
        setTimeout,
        clearTimeout,
        console
    });

    vm.runInContext(SOURCE, context, { filename: 'src/sidepanel/index.js' });
    domReady.dispatch();

    return { elements, sent, tab };
}

// 1. The control is never left permanently disabled by the markup.
{
    const html = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'sidepanel', 'index.html'), 'utf8');
    const tag = html.slice(html.indexOf('id="rotate-now"') - 120, html.indexOf('id="rotate-now"') + 120);

    assert.ok(!/\sdisabled[\s>]/.test(tag),
        'a `disabled` attribute with nothing to remove it makes the control unusable');
    console.log('  ok    the control is not born disabled');
}

// 2. Pressing it asks the current page to swap, when that page is the detection page.
{
    const app = build();
    app.elements.get('rotate-now').disabled = false;
    app.elements.get('rotate-now').click();

    assert.deepEqual(app.sent, [{ tabId: 42, action: 'rotateNow' }],
        'the swap control must ask the page to rotate');
    console.log('  ok    pressing swap asks the page to rotate');
}

// 3. It is enabled on the detection page and disabled everywhere else.
{
    const onPage = build({ tabUrl: 'https://matrix.tencent.com/ai-detect/' });
    assert.equal(onPage.elements.get('rotate-now').disabled, false,
        'the control must be usable on the page that owns the address');

    const offPage = build({ tabUrl: 'https://example.com/' });
    assert.equal(offPage.elements.get('rotate-now').disabled, true,
        'the control must be unusable where there is no address to swap');
    console.log('  ok    the control follows the current tab');
}

// 4. A page with no content script answers nothing; the control must not stay busy.
{
    const app = build({ sendFails: true });
    app.elements.get('rotate-now').disabled = false;
    app.elements.get('rotate-now').click();

    assert.equal(app.elements.get('rotate-now').disabled, false,
        'a failed round trip must leave the control usable');
    console.log('  ok    a failed round trip leaves the control usable');
}

// 5. Off the detection page there is nothing to rotate, so no message is sent.
{
    const app = build({ tabUrl: 'https://example.com/' });
    app.elements.get('rotate-now').click();

    assert.deepEqual(app.sent, [], 'a page that cannot rotate must not receive the request');
    console.log('  ok    off the detection page nothing is sent');
}

// 6. The removed second control is gone from both the markup and the script.
{
    const html = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'sidepanel', 'index.html'), 'utf8');

    assert.ok(!/reset-usage/.test(html), 'the markup must not carry the duplicate control');
    assert.ok(!/resetButton/.test(SOURCE), 'the script must not look up the duplicate control');
    console.log('  ok    the duplicate control is gone from markup and script');
}

// 7. No control is bound without a guard, and no listener is attached to a missing node.
{
    assert.match(SOURCE, /if \(!head\) continue;/, 'each card header must be checked before use');
    assert.match(SOURCE, /const bind = \(element, event, handler\) => \{\s*if \(!element\) return;/,
        'the shared guard must exist');
    console.log('  ok    every control is guarded before binding');
}

// 8. A document without any of those elements must still run to the end.
//
// This is the behaviour the guards exist for, checked by running the panel against a document that
// answers null to every lookup rather than by matching the guard in the source. A panel that throws
// while binding stops halfway: the listeners registered before the throw stay, everything after it
// never happens, and the panel looks blank with no clue which control was missing.
{
    const domReady = makeEvent();
    let ranToEnd = false;

    const context = vm.createContext({
        chrome: {
            sidePanel: { setPanelBehavior: () => { ranToEnd = true; return Promise.resolve(); } },
            runtime: {},
            storage: {
                local: { get: (keys, cb) => cb({}), set() {} },
                onChanged: makeEvent()
            },
            tabs: {
                query: (info, cb) => cb([{ id: 1, url: 'https://matrix.tencent.com/ai-detect/' }]),
                sendMessage() {},
                onActivated: makeEvent(),
                onUpdated: makeEvent()
            }
        },
        document: {
            addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') domReady.addListener(fn); },
            getElementById: () => null,
            querySelectorAll: () => []
        },
        setTimeout,
        clearTimeout,
        console
    });

    vm.runInContext(SOURCE, context, { filename: 'src/sidepanel/index.js' });
    domReady.dispatch();

    assert.equal(ranToEnd, true,
        'the panel must reach its last statement even when every element is missing');
    console.log('  ok    a document with no controls does not throw');
}

console.log('');
console.log('PASS: 8/8 swap control checks');
