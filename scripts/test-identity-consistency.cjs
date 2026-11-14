// Verifies the page, the socket and the request header all carry one address per load.
//
// The captcha ticket is bound to the address that fetched it. The page fetches it over plain HTTPS,
// so if the socket carries a different address the server refuses the detection with "Invalid
// request". Three pieces have to agree, and each can silently drift on its own:
//
//   content.js   picks the address for this load and stores it for the socket
//   shim.js      appends it to the relay socket path
//   relay        uses it instead of a random one, validating it first
//   background   puts the same value on the page's own captcha request
//
// A drift here has no visible symptom until a detection is refused, so this pins each link.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8');

const content = read('content.js');
const shim = read('shim.js');
const relay = read('scripts/relay.cjs');
const background = read('background.js');

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

check('content and shim agree on the storage key', () => {
    const contentKey = content.match(/const IDENTITY_KEY = '([^']+)'/);
    const shimKey = shim.match(/const IDENTITY_KEY = '([^']+)'/);

    assert.ok(contentKey, 'content.js must declare IDENTITY_KEY');
    assert.ok(shimKey, 'shim.js must declare IDENTITY_KEY');
    assert.equal(shimKey[1], contentKey[1], 'the two keys must match');
});

// --- content picks one per load ------------------------------------------

check('content stores the identity before anything is sent', () => {
    const storeAt = content.indexOf('localStorage.setItem(IDENTITY_KEY, loadIdentity)');
    const publishAt = content.indexOf('publishIdentity(ensureIdentity())');

    assert.ok(storeAt > 0, 'the identity must be written to storage for the socket');
    assert.ok(publishAt > 0, 'the identity must be published to the background');
    assert.ok(storeAt < publishAt, 'storage must happen before the publish call');
});

check('content keeps one identity for the whole load', () => {
    // Re-generating mid-load would give the socket one address and the request rule another.
    assert.match(content, /if \(loadIdentity\) return loadIdentity;/, 'the load identity must be memoized');
});

check('content does NOT reuse an identity from an earlier load', () => {
    // Measured: an address serves four handshakes and is refused from the fifth onwards, for good.
    // Restoring the stored value would burn it and break every later load.
    const block = content.slice(content.indexOf('function ensureIdentity'), content.indexOf('function publishIdentity'));
    assert.ok(!block.includes('getItem(IDENTITY_KEY)'), 'the stored identity must not be read back as the source of truth');
    assert.ok(block.includes('loadIdentity = randomIdentity()'), 'each load must pick a fresh address');
});

// --- shim appends it -----------------------------------------------------

check('shim appends the identity to the relay path', () => {
    assert.match(shim, /return RELAY_URL \+ '\?xff=' \+ identity;/, 'shim must pass the identity on the socket path');
    assert.ok(
        shim.includes('relayUrl()') && !/useRelay \? RELAY_URL :/.test(shim),
        'the socket must use relayUrl(), not the bare constant'
    );
});

check('shim validates before appending', () => {
    // The value ends up in an upstream header; a newline would inject arbitrary headers.
    assert.match(
        shim,
        /if \(!identity \|\| !\/\^\\d\{1,3\}\(\\\.\\d\{1,3\}\)\{3\}\$\/\.test\(identity\)\) return RELAY_URL;/,
        'only a plain IPv4 literal may be appended'
    );
});

// --- relay honours it ----------------------------------------------------

check('relay reads the identity from the socket path', () => {
    assert.ok(relay.includes("new URLSearchParams(url.slice(queryAt + 1)).get('xff')"),
        'the relay must read the xff parameter');
    assert.match(relay, /const path = queryAt === -1 \? url : url\.slice\(0, queryAt\);/,
        'the path must be compared without the query');
});

check('relay still requires the exact origin and path', () => {
    assert.match(relay, /if \(path !== '\/ws' \|\| req\.headers\.origin !== ALLOWED_ORIGIN\)/,
        'accepting a query must not relax the origin check');
});

check('relay validates the identity before using it', () => {
    assert.ok(relay.includes('function isIpv4('), 'a validator must exist');
    assert.match(relay, /const ip = isIpv4\(requestedIp\) \? requestedIp : randomIp\(\);/,
        'the chosen address must be used only when it validates');
});

check('a retry keeps the identity so the ticket stays valid', () => {
    assert.match(relay, /const ip = isIpv4\(requestedIp\) \? requestedIp : stats\.ips\[stats\.ips\.length - 1\];/,
        'retries must not switch address, or the captcha ticket is invalidated');
});

// --- background puts it on the page's own requests -----------------------

check('background applies the identity to the captcha request', () => {
    assert.ok(background.includes("request.action === 'setIdentity'"), 'the handler must exist');
    assert.ok(background.includes('modifyHeaders'), 'a header rule must be installed');
    assert.ok(background.includes("header: 'x-forwarded-for'"), 'the header must be x-forwarded-for');

    for (const domain of ['matrix.tencent.com', 't.captcha.qq.com', 'captcha.gtimg.com']) {
        assert.ok(background.includes(domain), 'the rule must cover ' + domain);
    }
});

check('background validates the address it is given', () => {
    assert.match(background, /if \(!\/\^\\d\{1,3\}\(\\\.\\d\{1,3\}\)\{3\}\$\/\.test\(ip\)\)/,
        'an unvalidated address must not reach the header rule');
});

check('manifest grants the permissions the rule needs', () => {
    const manifest = JSON.parse(read('manifest.json'));

    assert.ok(manifest.permissions.includes('declarativeNetRequest'),
        'declarativeNetRequest is required for modifyHeaders');
    assert.ok(manifest.permissions.includes('declarativeNetRequestWithHostAccess'),
        'host access is required to modify requests to these origins');
    assert.ok(manifest.host_permissions.includes('https://t.captcha.qq.com/*'),
        'the captcha host must be granted, or the ticket is issued for another address');
});

// --- rotation happens before the address is spent -------------------------

check('the page reloads before the fifth handshake is attempted', () => {
    // An address is refused from its fifth handshake on, so the reload has to happen at the fourth.
    // Waiting for the refusal instead would show the user "Invalid request" and, worse, tempt a
    // rotate-on-ambiguous design, which is what once produced a reload loop.
    assert.match(content, /const USES_PER_IDENTITY = 4;/, 'the measured limit must be stated once');
    assert.match(content, /if \(identityUses\(\) >= USES_PER_IDENTITY\)/, 'the reload must be driven by the stored count');
    assert.match(content, /rotate\('identity-exhausted'\)/, 'and it must actually rotate');
});

check('a detection click counts towards the identity', () => {
    const start = content.indexOf('function monitorUsage');
    const handler = content.slice(start, content.indexOf('// Registering listeners', start));
    assert.ok(handler.length > 0, 'the click handler must be locatable');

    // The count lives in localStorage and is bumped by shim.js as each relay socket opens. The click
    // handler only reads it: a local `+= 1` would both miscount (one page load serves several
    // detections) and, when the variable was never declared, throw on every click.
    assert.ok(handler.includes('identityUses()'), 'the click handler must read the stored count');
    assert.ok(!/loadUses/.test(content), 'no local counter may shadow the stored one');
});

// --- the validator itself -------------------------------------------------

check('the relay validator rejects header injection', () => {
    // Rebuilt from the shipped source so this asserts the real predicate, not a copy of it.
    const start = relay.indexOf('function isIpv4(');
    const end = relay.indexOf('\n}', start) + 2;
    const fn = relay.slice(start, end);
    const isIpv4 = vm.runInNewContext('(' + fn + ')', {});

    assert.equal(isIpv4('112.80.1.2'), true);
    assert.equal(isIpv4('255.255.255.255'), true);
    assert.equal(isIpv4('1.2.3.4\r\nX-Injected: 1'), false, 'CRLF must be rejected');
    assert.equal(isIpv4('1.2.3'), false);
    assert.equal(isIpv4('1.2.3.4.5'), false);
    assert.equal(isIpv4('1.2.3.999'), false);
    assert.equal(isIpv4(''), false);
    assert.equal(isIpv4(null), false);
});

const failed = checks.filter(ok => !ok).length;
console.log('');
if (failed) {
    console.error(`${failed}/${checks.length} identity consistency checks failed`);
    process.exitCode = 1;
} else {
    console.log(`PASS: ${checks.length}/${checks.length} identity consistency checks`);
}
