// Verifies the page is never reloaded while the user is completing a captcha.
//
// The challenge lives in an iframe owned by the captcha SDK, so its text never reaches
// document.body.innerText - the phrase list cannot see it. Detection has to be by element, and
// every reload path has to consult it: a reload mid-challenge discards the user's work and hands
// them a new one, making manual solving pointless.
//
// Measured on the live page, the container is always in the DOM and hidden by being parked far
// off-screen with opacity 0, while offsetWidth still reads 300. An earlier version keyed on size
// and returned true with no challenge on screen. These fixtures carry the real geometry so that
// regression cannot come back.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

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

// --- the predicate, run for real ------------------------------------------

const start = content.indexOf('function captchaOpen()');
const end = content.indexOf('\n    }', start) + 6;
const captchaSource = content.slice(start, end);

// Builds a DOM just rich enough to run the shipped predicate.
function run({ byId = {}, viewport = { w: 1028, h: 754 } } = {}) {
    const detached = () => null;

    const context = vm.createContext({
        document: {
            getElementById: id => byId[id] || null,
            querySelector: detached,
            documentElement: { clientWidth: viewport.w, clientHeight: viewport.h }
        },
        window: {
            innerWidth: viewport.w,
            innerHeight: viewport.h,
            getComputedStyle: node => node.style || { display: 'block', visibility: 'visible', opacity: '1' }
        }
    });

    return vm.runInContext('(' + captchaSource + ')', context)();
}

const style = (patch = {}) => Object.assign(
    { display: 'block', visibility: 'visible', opacity: '1' }, patch);

// Real parked state: y = -1000000, 300x155, wrapper opacity 0.
const parked = () => ({
    getBoundingClientRect: () => ({ x: 0, y: -1000000, width: 300, height: 155, top: -1000000, left: 0, bottom: -999845, right: 300 }),
    parentElement: null,
    style: style({ opacity: '0' })
});

// Real challenge on screen: the screenshot showed a 360x360 panel centred in the page.
const onScreen = () => ({
    getBoundingClientRect: () => ({ x: 334, y: 197, width: 360, height: 360, top: 197, left: 334, bottom: 557, right: 694 }),
    parentElement: null,
    style: style()
});

check('no captcha element at all reads as closed', () => {
    assert.equal(run(), false);
});

check('the parked container reads as closed despite its size', () => {
    // This is the real idle state, and the reason size alone cannot be the test.
    assert.equal(run({ byId: { tcaptcha_iframe_dy: parked() } }), false);
});

check('the parked wrapper reads as closed too', () => {
    assert.equal(run({ byId: { tcaptcha_wrapper_transform_dy: parked() } }), false);
});

check('a challenge on screen reads as open', () => {
    assert.equal(run({ byId: { tcaptcha_iframe_dy: onScreen() } }), true);
});

check('a transparent challenge reads as closed', () => {
    const element = onScreen();
    element.style = style({ opacity: '0' });
    assert.equal(run({ byId: { tcaptcha_iframe_dy: element } }), false);
});

check('a display:none challenge reads as closed', () => {
    const element = onScreen();
    element.style = style({ display: 'none' });
    assert.equal(run({ byId: { tcaptcha_iframe_dy: element } }), false);
});

check('an ancestor hiding the challenge wins over the element itself', () => {
    // The SDK parks the wrapper, and the iframe inside it reports opacity 1.
    const wrapper = { parentElement: null, style: style({ opacity: '0' }) };
    const element = onScreen();
    element.parentElement = wrapper;

    assert.equal(run({ byId: { tcaptcha_iframe_dy: element } }), false);
});

check('a challenge scrolled out of view reads as closed', () => {
    const element = onScreen();
    element.getBoundingClientRect = () => ({ x: 334, y: 900, width: 360, height: 360, top: 900, left: 334, bottom: 1260, right: 694 });
    assert.equal(run({ byId: { tcaptcha_iframe_dy: element } }), false);
});

check('a zero-sized container reads as closed', () => {
    const element = onScreen();
    element.getBoundingClientRect = () => ({ x: 334, y: 197, width: 0, height: 0, top: 197, left: 334, bottom: 197, right: 334 });
    assert.equal(run({ byId: { tcaptcha_iframe_dy: element } }), false);
});

// --- every reload path consults it ---------------------------------------

check('the reload is guarded by the challenge check', () => {
    const retryStart = content.indexOf('function scheduleRetry');
    const retryEnd = content.indexOf('async function rotate', retryStart);
    const body = content.slice(retryStart, retryEnd);

    const guardAt = body.indexOf('if (captchaOpen())');
    const reloadAt = body.indexOf('location.reload()');

    assert.ok(guardAt > 0, 'scheduleRetry must check for an open challenge');
    assert.ok(reloadAt > 0, 'scheduleRetry must still be able to reload');
    assert.ok(guardAt < reloadAt, 'the check must come before the reload, not after');
});

check('waiting re-schedules rather than dropping the reload', () => {
    const retryStart = content.indexOf('function scheduleRetry');
    const retryEnd = content.indexOf('async function rotate', retryStart);
    const body = content.slice(retryStart, retryEnd);

    // Returning without re-scheduling would leave the page stuck on a spent address forever.
    assert.match(body, /if \(captchaOpen\(\)\) \{\s*scheduleRetry\(CAPTCHA_WAIT_MS\);/,
        'an open challenge must postpone, then be re-checked');
});

check('rotation itself refuses to act while a challenge is open', () => {
    const rotateStart = content.indexOf('async function rotate');
    const rotateEnd = content.indexOf('function handlePageState', rotateStart);
    const body = content.slice(rotateStart, rotateEnd);

    assert.match(body, /if \(captchaOpen\(\)\)/, 'rotate must bail out while the challenge is up');
});

check('location.reload has exactly one call site', () => {
    // A second, unguarded reload anywhere would defeat the guard silently.
    const calls = content.match(/location\.reload\(/g) || [];
    assert.equal(calls.length, 1, 'found ' + calls.length + ' call sites');
});

check('the reload guard does not depend on body text', () => {
    const retryStart = content.indexOf('function scheduleRetry');
    const retryEnd = content.indexOf('async function rotate', retryStart);
    const body = content.slice(retryStart, retryEnd);

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
