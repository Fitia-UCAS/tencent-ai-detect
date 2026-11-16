// Verifies the one reply the extension acts on: the server failing its own run.
//
// Recorded on the live site, twice in one load: the ticket and the text are accepted, the reply
// "waiting" arrives, and a few milliseconds later the socket carries
//
//   {"status": "failed", "msg": "Exception Occured!", "content_type": 0, "availableUses": 4, ...}
//
// instead of a report. It is not a refusal - no code 21 precedes it, no challenge is open - and it
// charges nothing, so nothing may rotate for it. What it does leave behind is a page showing the
// server's error and a detection that never ran, and the same text was answered on the very next
// press both times. These cases pin both halves: reading the frame, and asking again exactly once.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CONTENT_DIR = path.join(__dirname, '..', '..', 'src', 'content');
const SOURCES = ['core.js', 'identity.js', 'detection.js', 'engine.js', 'auto.js'].map(name => ({
    name: 'src/content/' + name,
    text: fs.readFileSync(path.join(CONTENT_DIR, name), 'utf8')
}));

// The frame as it was recorded, and the shapes it must not be confused with.
const RECORDED = '{"status": "failed", "msg": "Exception Occured!", "content_type": 0, ' +
    '"availableUses": 4, "feedback_token": "eyJhbGciOiJIUzI1NiJ9.payload.signature"}';
const REFUSAL = '{"status": "failed", "msg": "Invalid request"}';
const ACCEPTED = '{"code": "1", "evil_level": "0", "msg": "OK"}';
const WAITING = '{"status": "waiting", "remaining": 0}';

function load(bodyText = '待检测的文字') {
    const listeners = new Map();
    const clicks = [];
    const session = new Map();
    const stored = new Map();

    // Every measurement on the live page had hundreds of milliseconds between the press and the
    // reply, and one of the guards reads that gap. A test that runs in a single millisecond would
    // exercise a case the site never produces, so the clock is advanced explicitly instead.
    const clock = { at: Date.now() };

    const editor = {
        textContent: bodyText,
        focus() {},
        dispatchEvent() { return true; }
    };

    const button = {
        textContent: '立即检测',
        get disabled() { return false; },
        click() { clicks.push(editor.textContent); }
    };

    const sandbox = {
        document: {
            body: { innerText: bodyText },
            documentElement: {},
            getElementById() { return null; },
            querySelector(selector) {
                return selector.includes('contenteditable') ? editor : null;
            },
            querySelectorAll(selector) {
                return selector === 'button' ? [button] : [];
            },
            addEventListener() {},
            cookie: ''
        },
        localStorage: {
            getItem: key => (stored.has(key) ? stored.get(key) : null),
            setItem: (key, value) => stored.set(key, String(value)),
            removeItem: key => stored.delete(key)
        },
        sessionStorage: {
            getItem: key => (session.has(key) ? session.get(key) : null),
            setItem: (key, value) => session.set(key, String(value)),
            removeItem: key => session.delete(key)
        },
        location: { reload() {} },
        chrome: {
            runtime: {
                lastError: undefined,
                sendMessage() { return Promise.resolve(null); },
                onMessage: { addListener() {} }
            },
            storage: {
                local: { get() {}, set() {} },
                onChanged: { addListener() {} }
            }
        },
        MutationObserver: function () { this.observe = () => {}; },
        // Only the decisions are under test. Discarding the timers keeps the process from waiting on
        // a retry schedule that is not being observed here.
        setTimeout: () => 1,
        clearTimeout: () => {},
        setInterval: () => 1,
        clearInterval: () => {},
        Date: class FakeDate extends Date {
            static now() { return clock.at; }
        },
        console
    };

    // The scripts reach each other through window.__zq, and engine.js installs its listeners on
    // window, so window is the sandbox itself.
    sandbox.window = sandbox;
    sandbox.addEventListener = (type, fn) => listeners.set(type, fn);
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    for (const source of SOURCES) {
        vm.runInContext(source.text, sandbox, { filename: source.name });
    }

    const ZQ = sandbox.__zq;

    // A reply is only ever heard through this listener in a real page, so the test delivers it the
    // same way instead of calling the handler directly.
    const reply = frame => {
        const listener = listeners.get('zq:relay-frame');
        assert.equal(typeof listener, 'function', 'engine.js must listen for the socket replies');
        listener({ detail: frame });
    };

    return {
        ZQ,
        listeners,
        clicks,
        editor,
        reply,
        session,
        advance: ms => { clock.at += ms; },
        now: () => clock.at
    };
}

const failures = [];
const check = (name, fn) => {
    try {
        fn();
        process.stdout.write(`  ok    ${name}\n`);
    } catch (error) {
        failures.push(name);
        process.stdout.write(`  FAIL  ${name} - ${error.message}\n`);
    }
};

// --- reading the frame -------------------------------------------------------

check('the recorded frame is read as the server failing its own run', () => {
    const page = load();
    assert.equal(page.ZQ.readTransientFailure(RECORDED), 'Exception Occured!');
});

check('a refusal is not that failure', () => {
    const page = load();
    assert.equal(page.ZQ.readTransientFailure(REFUSAL), null,
        'a refused request is a different answer with a different response');
});

check('the other frames on the socket are not that failure either', () => {
    const page = load();
    for (const frame of [ACCEPTED, WAITING, '{"status": "success", "availableUses": 5}', '', 'null']) {
        assert.equal(page.ZQ.readTransientFailure(frame), null, frame);
    }
});

check('a frame that is not JSON is ignored rather than thrown on', () => {
    const page = load();
    assert.equal(page.ZQ.readTransientFailure('{"status": "failed", '), null);
    assert.equal(page.ZQ.readTransientFailure(undefined), null);
});

check('the reply is recorded where the attempt can see it, and nothing rotates for it', () => {
    const page = load();
    page.reply(RECORDED);

    assert.equal(page.ZQ.state.transientFailure.msg, 'Exception Occured!');
    assert.equal(typeof page.ZQ.state.transientFailure.at, 'number');
    assert.equal(page.ZQ.readState().rotations, 0, 'the address had nothing to do with it');
});

// --- asking again ------------------------------------------------------------

check('a failure after a press gets exactly one more ask', () => {
    const page = load();
    page.ZQ.autoDetect();
    assert.equal(page.clicks.length, 1, 'the first detection is asked for once');

    page.advance(300);
    page.reply(RECORDED);
    assert.equal(page.ZQ.attemptState(), 'retryable', 'the press is settled by what the server said');

    page.ZQ.autoDetect();
    assert.equal(page.clicks.length, 2, 'the text was answered on the next press when measured');

    page.ZQ.autoDetect();
    assert.equal(page.clicks.length, 2, 'and that is the end of it: one retry, not a loop');
});

check('a second failure in the same load is not retried again', () => {
    const page = load();
    page.ZQ.autoDetect();
    page.advance(300);
    page.reply(RECORDED);
    page.ZQ.autoDetect();

    page.advance(300);
    page.reply(RECORDED);
    page.ZQ.autoDetect();
    page.ZQ.autoDetect();

    assert.equal(page.clicks.length, 2, 'a server that keeps throwing must not be asked forever');
});

check('a failure from before the press does not settle it', () => {
    const page = load();
    page.ZQ.autoDetect();

    // An older failure belongs to an earlier press; reading it as this one's answer would retry a
    // request that is still in flight.
    page.ZQ.state.transientFailure = { at: page.now() - 60000, msg: 'Exception Occured!' };

    assert.equal(page.ZQ.attemptState(), 'submitted-unconfirmed',
        'a failure older than the attempt must not be read as its answer');
    page.ZQ.autoDetect();
    assert.equal(page.clicks.length, 1);
});

check('a different text is asked for on its own, not as a retry', () => {
    const page = load('第一段');
    page.ZQ.autoDetect();
    page.advance(300);
    page.reply(RECORDED);
    page.ZQ.autoDetect();
    assert.equal(page.clicks.length, 2, 'the retry belongs to the text it failed on');

    page.editor.textContent = '第二段';
    page.ZQ.autoDetect();
    page.ZQ.autoDetect();

    assert.equal(page.clicks.length, 3, 'new text gets one ask of its own');
});

check('a refusal still gets no retry at all', () => {
    const page = load();
    page.ZQ.autoDetect();

    // The page shows the server refusing: that request cannot be retried into a success.
    page.ZQ.pageState = () => 'ambiguous';
    page.reply(REFUSAL);

    page.ZQ.autoDetect();
    page.ZQ.autoDetect();

    assert.equal(page.clicks.length, 1, 'a refusal must keep the text unpressable');
    assert.equal(page.ZQ.attemptState(), 'blocked');
});

if (failures.length) {
    process.stdout.write(`\nFAIL: ${failures.length} of 10 checks\n`);
    process.exitCode = 1;
} else {
    process.stdout.write('\nPASS: 10/10 server-failure checks\n');
}
