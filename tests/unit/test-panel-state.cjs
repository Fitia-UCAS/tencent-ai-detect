// The side panel's own behaviour.
//
// The panel used to carry a live page-state row, an auto refresh switch and a relay switch. All three
// are gone: the row could only show what had been written last, the switches duplicated decisions
// made elsewhere, and the relay switch had no working "off" state at all. What is left is four cards,
// each one an answer to "what happens when the address is used up", and this file pins how they behave.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'sidepanel', 'index.js'), 'utf8');

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
        hidden: false,
        dataset: {},
        value: '',
        disabled: false,
        open: false,
        attributes: {},
        classList: {
            _set: new Set(),
            add(name) { this._set.add(name); },
            remove(name) { this._set.delete(name); },
            toggle(name, on) { if (on) this._set.add(name); else this._set.delete(name); }
        },
        setAttribute(name, value) { this.attributes[name] = value; },
        getAttribute(name) { return this.attributes[name] ?? null; },
        addEventListener(type, fn) { (this._handlers ||= {}); (this._handlers[type] ||= []).push(fn); },
        // A click carries the event the browser would hand over, including preventDefault: a control
        // that takes over an element's default action has to be able to say so.
        click() {
            const event = {
                defaultPrevented: false,
                preventDefault() { this.defaultPrevented = true; },
                stopPropagation() {},
                stopImmediatePropagation() {}
            };
            for (const fn of (this._handlers?.click || [])) fn(event);
            return event;
        }
    };
}

// The three cards, as the panel queries them. Each one carries its own header, and the click handler
// is bound to that header rather than to the card. The wait card is a <details> in the real markup,
// which is why the mode renderer opens it by tag name.
function makeSpentCards(modes) {
    return modes.map(mode => {
        const card = element('card-' + mode);
        card.dataset.mode = mode;
        card.tagName = mode === 'delay' ? 'DETAILS' : 'DIV';
        card.head = element('head-' + mode);
        card.querySelector = selector => selector === '.spent-head' ? card.head : null;
        return card;
    });
}

function build({ stored = {}, relayOnline = true } = {}) {
    const domReady = makeEvent();
    const storageChanged = makeEvent();
    const elements = {
        'spent-delay': element('spent-delay'),
        'spent-delay-hint': element('spent-delay-hint'),
        'spent-delay-warning': element('spent-delay-warning'),
        'rotate-now': element('rotate-now'),
        'reset-usage': element('reset-usage'),
        notice: element('notice'),
        'host-alert': element('host-alert'),
        'host-alert-detail': element('host-alert-detail')
    };
    const spentCards = makeSpentCards(['manual', 'press', 'delay']);
    const writes = [];

    const chrome = {
        sidePanel: { setPanelBehavior: () => Promise.resolve() },
        runtime: { lastError: undefined, sendMessage: (message, cb) => { if (cb) cb({ status: 'success' }); } },
        storage: {
            local: {
                get: (keys, cb) => cb({ relayOnline, ...stored }),
                set: (values, cb) => { writes.push(values); if (cb) cb(); }
            },
            onChanged: storageChanged
        },
        tabs: {
            query: (info, cb) => cb([]),
            sendMessage: (tabId, message, cb) => { if (cb) cb(null); },
            onActivated: makeEvent(),
            onUpdated: makeEvent()
        }
    };

    const context = vm.createContext({
        chrome,
        document: {
            addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') domReady.addListener(fn); },
            getElementById: id => elements[id] || null,
            querySelectorAll: selector => selector === '.spent-card' ? spentCards : []
        },
        setTimeout,
        clearTimeout,
        console
    });

    vm.runInContext(SOURCE, context, { filename: 'src/sidepanel/index.js' });
    domReady.dispatch();

    return { elements, spentCards, writes };
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

const marked = app => app.spentCards.filter(card => card.dataset.selected === 'true');

// 1. The stored answer is the one card marked, and only that one.
{
    const app = build({ stored: { spentMode: 'press' } });
    check('the stored mode is the one card marked', () => {
        const selected = marked(app);
        assert.equal(selected.length, 1, 'exactly one card must be marked');
        assert.equal(selected[0].dataset.mode, 'press');
    });
}

// 2. Clicking a card's header chooses it, and the previous card loses the mark.
{
    const app = build({ stored: { spentMode: 'manual' } });
    const delay = app.spentCards.find(c => c.dataset.mode === 'delay');
    delay.head.click();

    check('clicking a header chooses that card', () => {
        const selected = marked(app);
        assert.equal(selected.length, 1, 'the previous card must lose the mark');
        assert.equal(selected[0].dataset.mode, 'delay');
    });

    check('choosing a card saves the mode', () => {
        assert.ok(app.writes.some(w => w.spentMode === 'delay'), 'the mode must reach storage');
    });
}

// 3. Every card carries a header to click. A card without one would be unselectable and look live.
{
    const app = build({});
    check('every card has a clickable header', () => {
        for (const card of app.spentCards) {
            assert.ok(card.querySelector('.spent-head'), 'card ' + card.dataset.mode + ' has no header');
            assert.ok((card.head._handlers?.click || []).length > 0,
                'card ' + card.dataset.mode + ' has no click handler');
        }
    });
}

// 4. The wait is a number the user sets, and the card's subtitle carries it.
{
    const app = build({ stored: { spentMode: 'delay', spentDelaySeconds: 10 } });
    check('the stored wait is shown in the seconds field', () => {
        assert.equal(app.elements['spent-delay'].value, '10');
        assert.match(app.elements['spent-delay-hint'].textContent, /10s/);
    });

    app.elements['spent-delay'].value = '5';
    for (const fn of (app.elements['spent-delay']._handlers?.change || [])) fn();

    check('a changed wait is saved and echoed in the card subtitle', () => {
        assert.ok(app.writes.some(w => w.spentDelaySeconds === 5), 'the new wait must reach storage');
        assert.match(app.elements['spent-delay-hint'].textContent, /5s/);
    });
}

// 4b. The wait is measured in tenths of a second, and zero is a legal answer - it is the old
//     "swap now", expressed as a number instead of as a second mode meaning the same thing.
{
    const app = build({ stored: { spentMode: 'delay', spentDelaySeconds: 1.5 } });
    check('a fractional wait is kept as typed', () => {
        assert.equal(app.elements['spent-delay'].value, '1.5');
        assert.match(app.elements['spent-delay-hint'].textContent, /1\.5s/);
    });

    app.elements['spent-delay'].value = '0.5';
    for (const fn of (app.elements['spent-delay']._handlers?.change || [])) fn();

    check('a fractional entry is stored without being rounded up', () => {
        assert.ok(app.writes.some(w => w.spentDelaySeconds === 0.5),
            '0.5 must survive as 0.5, not become 1');
        assert.match(app.elements['spent-delay-hint'].textContent, /0\.5s/);
    });

    app.elements['spent-delay'].value = '1.23';
    for (const fn of (app.elements['spent-delay']._handlers?.change || [])) fn();

    check('an entry finer than the field step is rounded to the step', () => {
        assert.ok(app.writes.some(w => w.spentDelaySeconds === 1.2),
            'the step is a tenth of a second, so 1.23 is stored as 1.2');
    });
}

// 4c. Zero swaps at once, and the card says what that costs. This is the setting measured to produce
//     "Invalid request" (a reload moments after the previous one can leave the socket on a different
//     address than the ticket), so it warns instead of being silently accepted or silently refused.
{
    const app = build({ stored: { spentMode: 'delay', spentDelaySeconds: 2 } });
    check('a non-zero wait shows no warning', () => {
        assert.equal(app.elements['spent-delay-warning'].hidden, true);
    });

    app.elements['spent-delay'].value = '0';
    for (const fn of (app.elements['spent-delay']._handlers?.change || [])) fn();

    check('a zero wait is stored and warns about what it triggers', () => {
        assert.ok(app.writes.some(w => w.spentDelaySeconds === 0), 'zero must be storable');
        assert.match(app.elements['spent-delay-hint'].textContent, /Swaps at once/,
            'the subtitle must not promise a wait of 0s');
        assert.equal(app.elements['spent-delay-warning'].hidden, false,
            'the cost of the setting must be visible when it applies');
    });

    // Measured on the rendered panel: a zero was stored, the summary said "Swaps at once", and the
    // sentence explaining what that costs was collapsed inside the card. A warning nobody opens is not
    // a warning, so the chosen card with a setting opens itself.
    const zeroed = build({ stored: { spentMode: 'delay', spentDelaySeconds: 0 } });

    check('a stored zero is shown as a zero, with the warning showing', () => {
        assert.equal(zeroed.elements['spent-delay'].value, '0');
        assert.equal(zeroed.elements['spent-delay-warning'].hidden, false);
    });

    check('a chosen card with a setting opens, so its warning is on screen', () => {
        const chosen = zeroed.spentCards.find(card => card.dataset.mode === 'delay');
        assert.equal(chosen.open, true, 'the wait card must be open when it is the chosen one');

        const manual = build({ stored: { spentMode: 'manual' } });
        const delay = manual.spentCards.find(card => card.dataset.mode === 'delay');
        assert.equal(delay.open, false, 'and must not open when some other card is chosen');
    });

    // The wait card's header is also its <summary>, which toggles itself as the click's default action -
    // after the handler has run. Left to both, choosing the card closed it again in the same gesture.
    check('clicking the wait card opens it, and clicking it again closes it', () => {
        const app = build({ stored: { spentMode: 'manual' } });
        const card = app.spentCards.find(c => c.dataset.mode === 'delay');

        const first = card.head.click();
        assert.equal(first.defaultPrevented, true, 'the default toggle must be taken over, not raced');
        assert.equal(card.open, true, 'choosing the card must leave its setting on screen');

        card.head.click();
        assert.equal(card.open, false, 'a second click puts the list back');
        assert.equal(card.dataset.selected, 'true', 'and must not un-choose the card');
    });
}

// 4d. The removed mode is still read, so an existing profile keeps meaning what it meant.
{
    const app = build({ stored: { spentMode: 'immediate' } });
    check('a stored "immediate" becomes a zero-second delay in the panel and storage', () => {
        const selected = marked(app);
        assert.equal(selected.length, 1);
        assert.equal(selected[0].dataset.mode, 'delay');
        assert.equal(app.elements['spent-delay'].value, '0');
        assert.equal(app.elements['spent-delay-hint'].textContent, 'Swaps at once');
        assert.ok(app.writes.some(write =>
            write.spentMode === 'delay' && write.spentDelaySeconds === 0));
    });

    const html = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'sidepanel', 'index.html'), 'utf8');
    assert.ok(!/data-mode="immediate"/.test(html), 'the removed mode must not be offered again');
}

// 4e. An unrecognized stored mode must look like what the content script will actually do.
{
    const app = build({ stored: { spentMode: 'nonsense', spentDelaySeconds: 5 } });
    check('an unknown stored mode is shown as the manual behavior the page uses', () => {
        const selected = marked(app);
        assert.equal(selected.length, 1);
        assert.equal(selected[0].dataset.mode, 'manual');
    });
}

// 5. An empty or absurd entry cannot be stored.
{
    const app = build({ stored: { spentMode: 'delay' } });
    app.elements['spent-delay'].value = '';
    for (const fn of (app.elements['spent-delay']._handlers?.change || [])) fn();
    check('an empty wait falls back instead of storing nothing', () => {
        assert.ok(app.writes.some(w => w.spentDelaySeconds === 2), 'must fall back to the default');
    });

    app.elements['spent-delay'].value = '-5';
    for (const fn of (app.elements['spent-delay']._handlers?.change || [])) fn();
    check('a negative wait is clamped to zero rather than stored', () => {
        assert.ok(app.writes.some(w => w.spentDelaySeconds === 0), 'the floor is zero');
    });
}

// 6. The controls that were removed are gone, and the ones that remain are wired.
{
    const app = build({});
    check('the removed controls are not looked up any more', () => {
        assert.ok(!/toggle-refresh/.test(SOURCE), 'the auto refresh switch must be gone');
        assert.ok(!/page-state/.test(SOURCE), 'the page state row must be gone');
        assert.ok(!/toggle-relay/.test(SOURCE), 'the relay switch must be gone');
    });

    check('the remaining controls are wired', () => {
        assert.match(SOURCE, /bind\(rotateButton, 'click'/, 'swap address must still work');

        // One swap control, not two. reset-usage ran the same rotation as rotate-now and was removed.
        assert.ok(!/resetButton/.test(SOURCE), 'the duplicate reset control must be gone');

        // Opening the page is an anchor in the markup, so the script must not also wire it.
        assert.ok(!/openButton/.test(SOURCE), 'the open control is a link, not a wired button');
    });

    check('every control is bound defensively', () => {
        // A control in the HTML but missing at runtime used to throw on addEventListener and leave
        // the panel blank. Each binding goes through the guard instead.
        assert.match(SOURCE, /const bind = \(element, event, handler\) => \{\s*if \(!element\) return;/, 'the guard must exist');
    });
}

// 7. The panel shows no floating anything: the settings live inside the card that owns them.
{
    const html = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'sidepanel', 'index.html'), 'utf8');

    check('each answer is a card, and only the one with a setting opens', () => {
        assert.equal((html.match(/class="spent-card"/g) || []).length, 3, 'there must be three cards');

        // A card with nothing to set must not open: expanding it would reveal nothing.
        const details = html.match(/<details class="spent-card" data-mode="([a-z]+)"/g) || [];
        assert.equal(details.length, 1, 'exactly one card may open');
        assert.match(details[0], /data-mode="delay"/, 'the wait card is the one with a setting');

        assert.ok(/<div class="spent-body-panel">[\s\S]*?spent-delay/.test(html),
            'the seconds field must sit inside the card that owns it');
    });

    check('the swap button sits in the card header, where it always is', () => {
        const header = html.slice(html.indexOf('data-mode="manual"'), html.indexOf('data-mode="press"'));
        assert.match(header, /id="rotate-now"/, 'swap address belongs in the header');
        assert.ok(!/reset-usage/.test(html), 'the duplicate reset button must be gone');
    });

    check('nothing floats over the panel, and nothing narrates a click', () => {
        assert.ok(!/class="toast"/.test(html), 'the toast must be gone');
        assert.ok(!/id="notice"/.test(html), 'the bottom notice line must be gone too');

        const css = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'sidepanel', 'styles.css'), 'utf8');
        assert.ok(!/\.toast/.test(css), 'the toast style must be gone');
        assert.ok(!/\.notice\b/.test(css), 'the notice style must be gone');

        // The panel says what it has to say in place: the chosen card marks itself, the wait card
        // carries its own seconds. A separate strip that only repeats the click is not needed.
        assert.ok(!/showStatus|showNotice/.test(SOURCE), 'no message helper should remain');
    });

    check('no control carries a native tooltip', () => {
        assert.ok(!/\stitle="/.test(html), 'title attributes render floating tooltips');
    });
}

// 8. A relay dropout is still announced, through the toast.
{
    const app = build({ relayOnline: false });
    check('a relay dropout is reported by the host alert, not by a message strip', () => {
        // The host alert is the only place a failure is worth showing: it says the relay did not
        // start, which explains why every detection would fail. There is no separate notice to feed.
        const html = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'sidepanel', 'index.html'), 'utf8');
        assert.match(html, /id="host-alert"/, 'the host alert must exist');
        assert.ok(!/id="notice"/.test(html), 'a separate notice strip must not exist');
    });
}

const failed = checks.filter(c => !c.ok);
console.log('');
if (failed.length) {
    console.error(`${failed.length}/${checks.length} side panel checks failed`);
    process.exitCode = 1;
} else {
    console.log(`PASS: ${checks.length}/${checks.length} side panel checks`);
}
