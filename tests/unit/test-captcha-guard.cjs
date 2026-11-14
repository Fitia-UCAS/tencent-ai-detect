// Verifies the page is never reloaded while the user is completing the captcha.
//
// The challenge is rendered in an iframe owned by the captcha SDK, so its text never reaches
// body.innerText - the phrase table cannot see it. Detection has to be by element, and every reload
// path has to consult it: a reload mid-challenge discards the user's work and hands them a new one,
// which makes manual solving pointless.
//
// Measured on the live page, the container is always in the DOM and hidden by being parked far
// off-screen with opacity 0, while offsetWidth still reads 300:
//
//   div#tcaptcha_wrapper_transform_dy  offsetWidth 300  rect.y -1000000  opacity 0
//   iframe#tcaptcha_iframe_dy          offsetWidth 300  rect.y -1000000
//
// An earlier version keyed on size alone and reported a challenge on an idle page. These fixtures
// carry the real geometry, so that regression cannot come back and silently stop every reload.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CONTENT_DIR = path.join(__dirname, '..', '..', 'src', 'content');
const ORDER = ['core.js', 'identity.js', 'detection.js', 'engine.js', 'index.js'];
const SOURCES = ORDER.map(name => ({
    name: 'src/content/' + name,
    text: fs.readFileSync(path.join(CONTENT_DIR, name), 'utf8')
}));
const engine = fs.readFileSync(path.join(CONTENT_DIR, 'engine.js'), 'utf8');

const checks = [];
const check = (name, fn) => {
    try {
        fn();
        checks.push(true);
        console.log('  ok    ' + name);
    } catch (error) {
        checks.push(false);
        console.log('  FAIL  ' + name + '  - ' + error.message);
    }
};

const style = (patch = {}) => Object.assign(
    { display: 'block', visibility: 'visible', opacity: '1' }, patch);

// Real parked state: y = -1000000, 300x155, wrapper opacity 0.
const parked = () => ({
    getBoundingClientRect: () => ({
        x: 0, y: -1000000, width: 300, height: 155, top: -1000000, left: 0, bottom: -999845, right: 300
    }),
    parentElement: null,
    style: style({ opacity: '0' })
});

// Real challenge on screen: the screenshot showed a 360x360 panel in the page.
const onScreen = () => ({
    getBoundingClientRect: () => ({
        x: 334, y: 197, width: 360, height: 360, top: 197, left: 334, bottom: 557, right: 694
    }),
    parentElement: null,
    style: style()
});

// Runs the content layer over a DOM that contains (or does not) a challenge element, then asks the
// shipped predicate. Only detection's own surface is exercised.
function captchaOpenWith(element) {
    const sandbox = {
        window: {
            innerWidth: 1028,
            innerHeight: 754,
            getComputedStyle: node => (node && node.style) || style()
        },
        document: {
            body: { innerText: '' },
            documentElement: { clientWidth: 1028, clientHeight: 754 },
            getElementById: id => (element && element.id === id ? element : null),
            querySelector: () => null,
            addEventListener() {},
            querySelectorAll() { return []; },
            cookie: ''
        },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        location: { reload() {} },
        chrome: {
            runtime: { lastError: undefined, sendMessage() {}, onMessage: { addListener() {} } },
            storage: { local: { get() {}, set() {} }, onChanged: { addListener() {} } }
        },
        MutationObserver: function () { this.observe = () => {}; },
        setTimeout, clearTimeout, setInterval, clearInterval, console, Date, Promise
    };

    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);

    // Only up to detection: index.js registers listeners and starts timers this test does not need.
    for (const source of SOURCES.slice(0, 3)) {
        vm.runInContext(source.text, sandbox, { filename: source.name });
    }

    return Boolean(sandbox.window.__zq.captchaOpen());
}

const withId = (id, element) => Object.assign(element, { id });

check('no challenge element at all reads as closed', () => {
    assert.equal(captchaOpenWith(null), false);
});

check('the parked container reads as closed despite its size', () => {
    // The real idle state, and the reason size alone cannot be the test.
    assert.equal(captchaOpenWith(withId('tcaptcha_iframe_dy', parked())), false);
});

check('the parked wrapper reads as closed too', () => {
    assert.equal(captchaOpenWith(withId('tcaptcha_wrapper_transform_dy', parked())), false);
});

check('a challenge on screen reads as open', () => {
    assert.equal(captchaOpenWith(withId('tcaptcha_iframe_dy', onScreen())), true);
});

check('a transparent challenge reads as closed', () => {
    const element = withId('tcaptcha_iframe_dy', onScreen());
    element.style = style({ opacity: '0' });
    assert.equal(captchaOpenWith(element), false);
});

check('a display:none challenge reads as closed', () => {
    const element = withId('tcaptcha_iframe_dy', onScreen());
    element.style = style({ display: 'none' });
    assert.equal(captchaOpenWith(element), false);
});

check('an ancestor hiding the challenge wins over the element', () => {
    // The SDK parks the wrapper; the iframe inside it still reports opacity 1.
    const element = withId('tcaptcha_iframe_dy', onScreen());
    element.parentElement = { parentElement: null, style: style({ opacity: '0' }) };
    assert.equal(captchaOpenWith(element), false);
});

check('a challenge scrolled out of view reads as closed', () => {
    const element = withId('tcaptcha_iframe_dy', onScreen());
    element.getBoundingClientRect = () => ({
        x: 334, y: 900, width: 360, height: 360, top: 900, left: 334, bottom: 1260, right: 694
    });
    assert.equal(captchaOpenWith(element), false);
});

check('a zero-sized container reads as closed', () => {
    const element = withId('tcaptcha_iframe_dy', onScreen());
    element.getBoundingClientRect = () => ({
        x: 334, y: 197, width: 0, height: 0, top: 197, left: 334, bottom: 197, right: 334
    });
    assert.equal(captchaOpenWith(element), false);
});

// --- every reload path consults it ---------------------------------------

check('the reload is guarded by the challenge check', () => {
    const retryStart = engine.indexOf('ZQ.scheduleRetry');
    const retryEnd = engine.indexOf('ZQ.currentState', retryStart);
    const body = engine.slice(retryStart, retryEnd);

    const guardAt = body.indexOf('if (ZQ.captchaOpen())');
    const reloadAt = body.indexOf('location.reload()');

    assert.ok(guardAt > 0, 'scheduleRetry must check for an open challenge');
    assert.ok(reloadAt > 0, 'scheduleRetry must still be able to reload');
    assert.ok(guardAt < reloadAt, 'the check must come before the reload');
});

check('waiting re-schedules rather than dropping the reload', () => {
    const retryStart = engine.indexOf('ZQ.scheduleRetry');
    const retryEnd = engine.indexOf('ZQ.currentState', retryStart);
    const body = engine.slice(retryStart, retryEnd);

    // Returning without re-scheduling would leave the page stuck on a spent address forever.
    assert.match(body, /if \(ZQ\.captchaOpen\(\)\) \{\s*ZQ\.scheduleRetry\(ZQ\.CAPTCHA_WAIT_MS\);/,
        'an open challenge must postpone, then be re-checked');
});

check('rotation itself refuses to act while a challenge is open', () => {
    const rotateStart = engine.indexOf('ZQ.rotate = async');
    const rotateEnd = engine.indexOf('ZQ.handlePageState', rotateStart);
    const body = engine.slice(rotateStart, rotateEnd);

    assert.match(body, /if \(ZQ\.captchaOpen\(\)\)/, 'rotate must bail out while it is up');
});

check('location.reload has exactly one call site', () => {
    // A second, unguarded reload anywhere would defeat the guard silently.
    const calls = engine.match(/location\.reload\(/g) || [];
    assert.equal(calls.length, 1, 'found ' + calls.length + ' call sites');
});

check('the guard does not depend on body text', () => {
    const retryStart = engine.indexOf('ZQ.scheduleRetry');
    const retryEnd = engine.indexOf('ZQ.currentState', retryStart);
    const body = engine.slice(retryStart, retryEnd);

    assert.ok(!body.includes('CAPTCHA_PHRASES'), 'the guard must not rely on innerText phrases');
});

const failed = checks.filter(ok => !ok).length;
console.log('');
if (failed) {
    console.error(`${failed}/${checks.length} captcha guard checks failed`);
    process.exitCode = 1;
} else {
    console.log(`PASS: ${checks.length}/${checks.length} captcha guard checks`);
}
