// Verifies the page, the socket and the request header all carry one address per load.
//
// The captcha ticket is bound to the address that fetched it, and the page fetches it over plain
// HTTPS on its own. So the socket has to carry the same address, and so does the page's request to
// the captcha host. Three pieces have to agree, and each can drift on its own with no visible
// symptom until a detection is refused:
//
//   src/content/identity.js    picks the address for this load and publishes it
//   src/shim/index.js          appends it to the relay socket path
//   src/relay/server.cjs       uses it instead of a random one, validating it first
//   src/background/identity.js puts the same value on the page's own captcha request
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const identity = read('src/content/identity.js');
const contentIndex = read('src/content/index.js');
const shim = read('src/shim/index.js');
const relay = read('src/relay/server.cjs');
const background = read('src/background/identity.js');
const messages = read('src/background/messages.js');
const files = read('src/content/files.js');
const manifest = JSON.parse(read('manifest.json'));

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

// --- one shared key -------------------------------------------------------

check('the shim reads the same storage keys the content script writes', () => {
    for (const name of ['IDENTITY_KEY', 'USE_COUNT_KEY']) {
        const content = identity.match(new RegExp(name + " = '([^']+)'"));
        const shimValue = shim.match(new RegExp(name + " = '([^']+)'"));

        assert.ok(content, 'identity.js must declare ' + name);
        assert.ok(shimValue, 'shim.js must declare ' + name);
        assert.equal(shimValue[1], content[1], name + ' must match');
    }
});

// --- content picks one per load ------------------------------------------

check('the identity is stored before it is published', () => {
    const storeAt = identity.indexOf('localStorage.setItem(ZQ.IDENTITY_KEY, loadIdentity)');
    const returnAt = identity.indexOf('return loadIdentity;', storeAt);
    const publishAt = contentIndex.indexOf('ZQ.publishIdentity(ZQ.ensureIdentity())');

    assert.ok(storeAt > 0, 'the address must reach storage for the shim');
    assert.ok(returnAt > storeAt, 'ensureIdentity must return it');
    assert.ok(publishAt > 0, 'index.js must publish it to the background');
});

check('one identity is kept for the whole load', () => {
    // Re-generating mid-load would give the socket one address and the request rule another.
    assert.match(identity, /if \(loadIdentity\) return loadIdentity;/, 'must be memoized');
});

check('an identity from an earlier load is NOT reused', () => {
    // Measured: an address serves four handshakes and is refused from the fifth onwards, for good.
    // Restoring the stored value would burn it and break every later load.
    const block = identity.slice(identity.indexOf('ZQ.ensureIdentity'), identity.indexOf('ZQ.identityUses'));
    assert.ok(!block.includes('getItem(ZQ.IDENTITY_KEY)'), 'the stored value must not be the source');
    assert.ok(block.includes('loadIdentity = ZQ.randomIdentity()'), 'each load must pick a fresh one');
});

check('the reload happens before the fifth handshake', () => {
    assert.match(identity, /ZQ\.USES_PER_IDENTITY = 4;/, 'the measured limit must be stated once');
    assert.match(contentIndex, /if \(ZQ\.identityUses\(\) >= ZQ\.USES_PER_IDENTITY\)/,
        'the reload must be driven by the socket count, not by clicks');
    assert.match(contentIndex, /ZQ\.rotate\('identity-exhausted'\)/, 'and it must actually rotate');
});

check('the identity module is loaded before it is used', () => {
    const order = files.indexOf("'src/content/identity.js'");
    const detection = files.indexOf("'src/content/detection.js'");
    const index = files.indexOf("'src/content/index.js'");

    assert.ok(order > 0, 'files.js must list identity.js');
    assert.ok(order < detection, 'identity must load before detection');
    assert.ok(index > order, 'index must load last');
});

// --- the shim appends it and counts handshakes ---------------------------

check('the shim appends the identity to the relay path', () => {
    assert.match(shim, /return RELAY_URL \+ '\?xff=' \+ identity;/, 'must pass it on the socket path');
    assert.ok(shim.includes('relayUrl()'), 'the socket must use relayUrl()');
    assert.ok(!/useRelay \? RELAY_URL :/.test(shim), 'not the bare constant');
});

check('the shim validates before appending', () => {
    // The value ends up in an upstream header; a newline would inject arbitrary headers.
    assert.match(shim, /if \(!identity \|\| !\/\^\\d\{1,3\}\(\\\.\\d\{1,3\}\)\{3\}\$\/\.test\(identity\)\) return RELAY_URL;/,
        'only a plain IPv4 literal may be appended');
});

check('the shim counts the handshakes it opens', () => {
    const openAt = shim.indexOf('sock.onopen');
    const openBody = shim.slice(openAt, openAt + 400);

    assert.ok(openBody.includes('if (useRelay) countUse();'),
        'a relay socket that opened is one handshake on this address');
});

// --- the relay honours it ------------------------------------------------

check('the relay reads the identity from the socket path', () => {
    assert.ok(relay.includes("new URLSearchParams(url.slice(queryAt + 1)).get('xff')"),
        'the relay must read the xff parameter');
    assert.match(relay, /const path = queryAt === -1 \? url : url\.slice\(0, queryAt\);/,
        'the path must be compared without the query');
});

check('the relay still requires the exact origin and path', () => {
    assert.match(relay, /if \(path !== '\/ws' \|\| req\.headers\.origin !== ALLOWED_ORIGIN\)/,
        'accepting a query must not relax the origin check');
});

check('the relay validates the identity before using it', () => {
    assert.ok(relay.includes('function isIpv4('), 'a validator must exist');
    assert.match(relay, /const ip = isIpv4\(requestedIp\) \? requestedIp : randomIp\(\);/,
        'the named address must be used only when it validates');
});

check('a retry keeps the identity so the ticket stays valid', () => {
    assert.match(relay, /const ip = isIpv4\(requestedIp\) \? requestedIp : stats\.ips\[stats\.ips\.length - 1\];/,
        'retries must not switch address, or the captcha ticket is invalidated');
});

// --- the background puts it on the page's own requests -------------------

check('the identity reaches the captcha request', () => {
    assert.ok(background.includes('modifyHeaders'), 'a header rule must be installed');
    assert.ok(background.includes("header: 'x-forwarded-for'"), 'the header must be x-forwarded-for');

    for (const domain of ['matrix.tencent.com', 't.captcha.qq.com', 'captcha.gtimg.com']) {
        assert.ok(background.includes(domain), 'the rule must cover ' + domain);
    }
});

check('an unvalidated address never reaches the header rule', () => {
    assert.match(background, /export function isIpv4\(value\)/, 'the background validates too');
    assert.match(background, /if \(!isIpv4\(ip\)\) return false;/,
        'apply must refuse anything else');
});

check('the message router answers setIdentity', () => {
    assert.ok(messages.includes('setIdentity('), 'the handler must exist');
    assert.ok(messages.includes('identity.apply(request.ip)'), 'and it must use the module');
});

check('the manifest grants what the rule needs', () => {
    assert.ok(manifest.permissions.includes('declarativeNetRequest'),
        'declarativeNetRequest is required for modifyHeaders');
    assert.ok(manifest.permissions.includes('declarativeNetRequestWithHostAccess'),
        'host access is required to modify requests to these origins');
    assert.ok(manifest.host_permissions.includes('https://t.captcha.qq.com/*'),
        'the captcha host must be granted, or the ticket is issued for another address');

    const contentScript = manifest.content_scripts[1];
    assert.ok(contentScript.js.includes('src/content/identity.js'),
        'the manifest must load the identity module');
});

// --- the validators themselves -------------------------------------------

check('the background validator rejects header injection', () => {
    // Built from the shipped source so this asserts the real predicate, not a copy.
    const start = background.indexOf('export function isIpv4');
    const end = background.indexOf('\n}', start) + 2;
    const source = background.slice(start, end).replace('export function', 'function');
    const isIpv4 = vm.runInNewContext('(' + source + ')', {});

    assert.equal(isIpv4('112.80.1.2'), true);
    assert.equal(isIpv4('255.255.255.255'), true);
    assert.equal(isIpv4('1.2.3.4\r\nX-Injected: 1'), false, 'CRLF must be rejected');
    assert.equal(isIpv4('1.2.3'), false);
    assert.equal(isIpv4('1.2.3.4.5'), false);
    assert.equal(isIpv4('1.2.3.999'), false);
    assert.equal(isIpv4(''), false);
    assert.equal(isIpv4(null), false);
});

check('the relay validator rejects header injection', () => {
    const start = relay.indexOf('function isIpv4(');
    const end = relay.indexOf('\n}', start) + 2;
    const isIpv4 = vm.runInNewContext('(' + relay.slice(start, end) + ')', {});

    assert.equal(isIpv4('112.80.1.2'), true);
    assert.equal(isIpv4('1.2.3.4\r\nX-Injected: 1'), false);
    assert.equal(isIpv4('1.2.3'), false);
});

const failed = checks.filter(ok => !ok).length;
console.log('');
if (failed) {
    console.error(`${failed}/${checks.length} identity consistency checks failed`);
    process.exitCode = 1;
} else {
    console.log(`PASS: ${checks.length}/${checks.length} identity consistency checks`);
}
