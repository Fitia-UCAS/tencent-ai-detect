// A press made while the page is asking for a challenge must not go out.
//
// The condition is the page state word, and getting that wrong once is why this file exists in its
// current shape. The guard first required the challenge widget to be inside the viewport, which looks
// stricter and is actually weaker: the site hides the widget by parking it at a negative offset, and
// it parks it again while swapping in a replacement after a failed attempt. So exactly when a
// challenge was live and being redrawn, the geometry read "no challenge" and the press went through.
//
// Measured on the live page, the node that is genuinely on screen:
//     wrap  #tcaptcha_wrapper_transform_dy  y 193   z-index 2000000002  opacity 1
// and the same node mid-swap:
//     wrap  #tcaptcha_wrapper_transform_dy  y -10000   frame y -9999
// A press recorded at that moment carried `challengeOpen: false` with `state: "captcha"`, and the
// geometry-based guard allowed it.
//
// What the trail says about pressing in that state, across every run on record:
//     captcha  -> 8 presses answered `code 21`, 1 produced no ticket, 1 was answered OK
//     ok       -> 84 answered OK
// So the state word separates the two, and the geometry does not.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'content', 'index.js'), 'utf8');

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

// A page stub just rich enough for monitorUsage(): one capture-phase click listener, a document with
// the elements this file touches, and enough of an element to be recognised as a detect button.
function buildPage({ state: initial, challengeOpen: initialChallenge }) {
    let state = initial;
    let challengeOpen = initialChallenge;

    const listeners = [];
    const appended = [];
    const traces = [];
    const states = [];

    const fakeDocument = {
        addEventListener(type, listener) {
            if (type === 'click') listeners.push(listener);
        },
        getElementById() { return null; },
        querySelector() { return null; },
        createElement() {
            return {
                id: '',
                textContent: '',
                hidden: false,
                style: { cssText: '' }
            };
        },
        get body() { return { appendChild(node) { appended.push(node); } }; },
        get documentElement() { return { appendChild(node) { appended.push(node); } }; }
    };

    const ZQ = {
        state: { contextAlive: true, enabled: true, rotating: false, quickPass: null },
        isAlive: () => true,
        isEnabled: () => true,
        canRotate: () => true,
        canAutoAct: () => true,
        pageState: () => state,
        captchaOpen: () => challengeOpen,
        identityUses: () => 1,
        identitySpent: () => false,
        signedIn: () => true,
        pageAge: () => 1000,
        readQuota: () => ({ exhausted: false, remaining: 5 }),
        currentState: status => ({ status }),
        reportState: value => states.push(value),
        trace: (name, detail) => traces.push({ name, detail }),
        send: () => Promise.resolve(null),
        snapshot: () => null,
        handlePageState: () => {},
        startWatchdog: () => {},
        resolveSpentSettings: stored => stored,
        ensureIdentity: () => '112.80.1.2',
        publishIdentity: () => Promise.resolve(true),
        currentIdentity: () => '112.80.1.2',
        noteContextError: () => {}
    };

    const sandbox = {
        window: { __zqDetectReady: false, __zq: ZQ, addEventListener() {} },
        document: fakeDocument,
        // watchResults() installs a MutationObserver over the whole document. The press guard is what
        // this file exercises, so the observer is a no-op here; the alternative would be a full DOM.
        MutationObserver: function MutationObserver() {
            return { observe() {} };
        },
        chrome: {
            runtime: { onMessage: { addListener() {} } },
            storage: { local: { get() {} }, onChanged: { addListener() {} } }
        },
        setTimeout,
        clearTimeout,
        console
    };
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(SOURCE, sandbox);

    // The two facts the guard reads, made movable so a test can walk the page through the sequence a
    // real load goes through: press, widget appears, widget is swapped, press again.
    return {
        listeners, traces, states, appended, ZQ,
        setChallenge(open) { challengeOpen = open; },
        setPageState(next) { state = next; }
    };
}

function pressEvent() {
    const button = { textContent: '立即检测', className: 'detect-btn' };
    return {
        target: button,
        prevented: false,
        stopped: false,
        stopImmediate: false,
        preventDefault() { this.prevented = true; },
        stopPropagation() { this.stopped = true; },
        stopImmediatePropagation() { this.stopImmediate = true; }
    };
}

function press(page) {
    const event = pressEvent();
    for (const listener of page.listeners) listener(event);
    return event;
}

// --- it fires ---------------------------------------------------------------

check('a press while the page asks for a challenge is stopped before it is sent', () => {
    const page = buildPage({ state: 'captcha', challengeOpen: true });
    const event = press(page);

    assert.equal(event.prevented, true, 'the press must be cancelled');
    assert.equal(event.stopped, true, 'and must not reach the site handler');
    assert.equal(event.stopImmediate, true);
});

check('and it fires with the challenge off screen, which is the case that used to slip through', () => {
    // This is the measured failure: page state `captcha`, the widget parked at y -9999 while the site
    // swapped in the replacement, so `captchaOpen()` was false. Geometry says "no challenge"; the page
    // is nonetheless asking for one and the ticket cannot be usable yet.
    const page = buildPage({ state: 'captcha', challengeOpen: false });
    const event = press(page);

    assert.equal(event.prevented, true,
        'a parked widget must not be read as "no challenge" while the page says captcha');
});

check('the state word alone decides, not the geometry', () => {
    // Same widgets, opposite states: if the guard keyed on geometry these two would agree.
    const pending = buildPage({ state: 'captcha', challengeOpen: false });
    const healthy = buildPage({ state: 'ok', challengeOpen: false });

    assert.equal(press(pending).prevented, true);
    assert.equal(press(healthy).prevented, false);
});

check('the stop is recorded with why, on the trail', () => {
    const page = buildPage({ state: 'captcha', challengeOpen: true });
    press(page);

    const blocked = page.traces.find(entry => entry.name === 'press-blocked');
    assert.ok(blocked, 'a blocked press must leave a trail entry');
    assert.equal(blocked.detail.reason, 'challenge-pending');
    // Geometry is still recorded, because it is what explains a swap even though it does not decide.
    assert.equal(blocked.detail.challengeOpen, true);
});

check('and the person pressing is told, rather than left with a dead button', () => {
    const page = buildPage({ state: 'captcha', challengeOpen: true });
    press(page);

    const notice = page.appended[page.appended.length - 1];
    assert.ok(notice, 'a notice must be drawn');
    assert.match(notice.textContent, /人机验证/,
        'the notice must name the thing to do, not just say "blocked"');
});

check('no handshake is counted for a press that never goes out', () => {
    const page = buildPage({ state: 'captcha', challengeOpen: true });
    const before = JSON.stringify(page.ZQ.state.quickPass);
    press(page);

    assert.equal(JSON.stringify(page.ZQ.state.quickPass), before);
    assert.equal(page.traces.some(entry => entry.name === 'press'), false,
        'the press must not be traced as having happened');
});

// --- and it does not overreach ----------------------------------------------

check('a normal press on a healthy page still goes through', () => {
    const page = buildPage({ state: 'ok', challengeOpen: false });
    const event = press(page);

    assert.equal(event.prevented, false, 'the normal path must not be blocked');
    assert.equal(page.traces.some(entry => entry.name === 'press'), true);
});

check('a healthy page with a widget parked off screen still presses', () => {
    // The empty state has the container in the DOM at all times, parked far off screen. A guard that
    // keyed on the node's presence would block every press forever.
    const page = buildPage({ state: 'ok', challengeOpen: false });
    assert.equal(press(page).prevented, false);
});

check('a press made to ask for a challenge is not blocked', () => {
    // The first press of a run happens on an `ok` page with no challenge anywhere. It is the press
    // that asks the site to start one, so blocking it would leave the user no way to get a ticket.
    const page = buildPage({ state: 'ok', challengeOpen: false });
    assert.equal(press(page).prevented, false);
});

check('a solved challenge hands the press back to the page', () => {
    // Solving is reported by the state word going back to ok; if it never did, the guard would keep
    // refusing and the page could never be used again.
    const page = buildPage({ state: 'captcha', challengeOpen: true });
    assert.equal(press(page).prevented, true);

    page.setPageState('ok');
    page.setChallenge(false);
    assert.equal(press(page).prevented, false);
});

check('the guard is not reachable through the quick-pass retry', () => {
    // A short no-challenge ticket grants one retry past the stale-refusal guard. It must not grant one
    // past a pending challenge: the challenge is a fact about the page, not a stale view of a refusal.
    const page = buildPage({ state: 'captcha', challengeOpen: true });
    page.ZQ.state.quickPass = { ticketLength: 170, at: Date.now() };

    assert.equal(press(page).prevented, true,
        'a pending quick pass must not let a press through a pending challenge');
});

check('quota and other states are left to the page', () => {
    // The guard reads the site's own wording, so it stays on the states it can name.
    for (const state of ['quota', 'ambiguous']) {
        const page = buildPage({ state, challengeOpen: false });
        if (state === 'ambiguous') continue; // covered by the stale-refusal guard, not this one
        assert.equal(press(page).prevented, false, state + ' must not be blocked here');
    }
});

const failed = checks.filter(ok => !ok).length;
console.log('');
if (failed) {
    console.error(`${failed}/${checks.length} challenge-press checks failed`);
    process.exitCode = 1;
} else {
    console.log(`PASS: ${checks.length}/${checks.length} challenge-press checks`);
}
