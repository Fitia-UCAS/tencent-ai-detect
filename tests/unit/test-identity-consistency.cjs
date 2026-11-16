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
//   src/background/header-rules.js puts the same value on the page's own captcha request
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
const background = read('src/background/header-rules.js');
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

check('the identity is stored per tab before it is published', () => {
    const sessionAt = identity.indexOf('writeSession(ZQ.IDENTITY_KEY, loadIdentity)');
    const attrAt = identity.indexOf('retryAttribute(ZQ.IDENTITY_ATTR, loadIdentity)');
    const returnAt = identity.indexOf('return loadIdentity;', Math.max(sessionAt, attrAt));

    // index.js names the load's address once and publishes that same value, so what is traced and what
    // is published cannot drift apart. The call order is what matters, not that it is one expression.
    const ensureAt = contentIndex.indexOf('ZQ.ensureIdentity()');
    const publishAt = contentIndex.indexOf('ZQ.publishIdentity(identity)');

    assert.ok(sessionAt > 0, 'the address must reach sessionStorage for the shim');
    assert.ok(attrAt > 0, 'and the attribute the shim reads first, which survives a storage clear');
    assert.ok(returnAt > Math.max(sessionAt, attrAt), 'ensureIdentity must return it');
    assert.ok(ensureAt > 0, 'index.js must pick the load address');
    assert.ok(publishAt > ensureAt, 'and publish that same address to the background');
});

check('the identity never goes through storage every tab shares', () => {
    // localStorage is shared by every tab of the site. While the address was read from it first, a
    // second tab silently became the first tab's socket address - the divergence that ends in
    // "Invalid request".
    //
    // It is still read, but only as the last resort after both per-tab surfaces: returning nothing
    // at all makes the relay draw a random address while the ticket carries the rule's, which is a
    // guaranteed refusal rather than a possible stale one. So the assertion is about order, not about
    // the string being absent.
    const block = identity.slice(
        identity.indexOf('ZQ.ensureIdentity'), identity.indexOf('ZQ.identityUses'));

    // Writing it is required: the shim's last resort reads it, and an unwritten last resort is
    // worse than none at all - see the note in ensureIdentity on what a missing address does.
    assert.ok(/localStorage\.setItem/.test(block), 'the load must leave a fallback value');
    assert.ok(!/localStorage\.getItem/.test(block),
        'but the load must never read its own choice back from there: a stored value belongs to a spent address');

    const reader = shim.slice(shim.indexOf('function readTabValue'), shim.indexOf('function relayUrl'));
    const attrAt = reader.indexOf('getAttribute');
    const sessionAt = reader.indexOf('sessionStorage.getItem');
    const localAt = reader.indexOf('localStorage.getItem');

    assert.ok(attrAt > 0 && sessionAt > 0, 'both per-tab surfaces must be read');
    assert.ok(attrAt < sessionAt, 'the attribute is the synchronous one, so it comes first');
    assert.ok(localAt > sessionAt, 'the shared copy may only be the last resort');
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

check('the limit is the server allowance, and the press honours the chosen mode', () => {
    assert.match(identity, /ZQ\.USES_PER_IDENTITY = 5;/, 'the measured limit must be stated once');
    assert.match(identity, /ZQ\.identitySpent = function identitySpent\(\) \{[\s\S]{0,200}?USES_PER_IDENTITY/,
        'the limit must be decided from the socket count, in one place');
    assert.match(contentIndex, /if \(ZQ\.identitySpent\(\)\)/,
        'and the press must consult it rather than the refusal');

    // The press used to rotate unconditionally. Now only the 'press' mode does, because the other
    // modes answer this moment differently and rotating regardless would override the setting.
    assert.match(contentIndex, /if \(mode === 'press'\) ZQ\.forceRotate\('identity-exhausted'\)/,
        'the press mode is what rotates on the unservable click');
    assert.match(contentIndex, /ZQ\.readSpentMode\(\)/, 'decided from the stored preference');
});

// Measured: reaching the limit reloaded the page about 1.5s after the last usable detection landed,
// so its result was destroyed before it could be read. A spent address is now reported, and what
// happens next is decided in one place from the stored preference - never by the path that noticed.
check('the watchdog reports a spent address instead of reloading on its own', () => {
    const engine = read('src/content/engine.js');
    const watchdog = engine.slice(engine.indexOf('ZQ.startWatchdog'), engine.indexOf('ZQ.stopWatchdog'));

    assert.match(watchdog, /if \(!ZQ\.addressSpent\(\)\) return;/,
        'the watchdog still has to notice the spent address, since a click is not guaranteed');
    assert.match(watchdog, /ZQ\.onAddressSpent\('watchdog'\)/,
        'and it must hand the decision to the one place that makes it');
    assert.ok(!/ZQ\.rotate\(|location\.reload\(/.test(watchdog),
        'and must not rotate: that reload would throw the visible result away');
});

// The page saying its allowance is gone and the tab's own count reaching the limit are one question.
// Answering it in two places is how the page came to reload while the panel was set to keep it: the
// count was honoured, the wording was not.
check('one predicate answers "is the address spent", and one place acts on it', () => {
    const engine = read('src/content/engine.js');

    assert.match(engine, /ZQ\.addressSpent = function addressSpent\(\) \{\s*\n\s*return ZQ\.identitySpent\(\) \|\| ZQ\.pageState\(\) === 'quota';/,
        'both signals are asked in a single predicate');

    const handler = engine.slice(
        engine.indexOf('ZQ.handlePageState = function'),
        engine.indexOf('ZQ.forceRotate = function'));
    assert.match(handler, /ZQ\.onAddressSpent\(reason\)/,
        'the page-state handler delegates instead of rotating');
    assert.ok(!/ZQ\.rotate\(|ZQ\.forceRotate\(/.test(handler),
        'and never starts a rotation itself');
});

// The modes that keep the page must keep it on every path, including the observer and the watchdog.
// Only the mode that swaps may reach a rotation, and it is paced by the cooldown.
check('only the swapping mode can rotate, on any path', () => {
    const engine = read('src/content/engine.js');
    const decide = engine.slice(engine.indexOf('ZQ.onAddressSpent'), engine.indexOf('ZQ.WATCHDOG_MS'));

    assert.match(decide, /if \(mode === 'delay'\) \{[\s\S]*?ZQ\.forceRotate\('spent'\);/,
        'delay swaps once its wait is over, including a wait of zero');
    assert.ok(!/mode\s*[!=]==\s*'immediate'/.test(decide),
        'the removed mode must not survive as a second branch to the same decision');
    assert.equal((decide.match(/ZQ\.forceRotate\(/g) || []).length, 1,
        'exactly one branch may rotate, so no other mode can reach one');
    assert.match(decide, /ZQ\.reportSpentOnce\(\);\n    \};/,
        'everything else reports the state and leaves the page alone');
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
    assert.match(background, /if \(!isIpv4\(ip\)\) return false;|if \(!isIpv4\(ip\)\) return Promise\.resolve\(false\);/,
        'apply must refuse anything else');
});

check('the message router answers setIdentity for the sender tab', () => {
    assert.ok(messages.includes('setIdentity('), 'the handler must exist');
    assert.ok(messages.includes('identity.apply(request.ip, tabId)'), 'and it must use the module');
    assert.match(messages, /sender\.tab\.id/, 'with the tab the message came from');
});

// A rule that is not scoped to one tab applies everywhere, which is the global behaviour these
// rules were moved to session scope to avoid: the browser refuses tabIds on a dynamic rule with
// "These are only supported for session-scoped rules".
check('the header rule is scoped to the tab that published it', () => {
    assert.ok(background.includes('updateSessionRules'), 'tabIds are only accepted in the session ruleset');
    assert.ok(!background.includes('updateDynamicRules'), 'a dynamic rule cannot carry tabIds');
    assert.match(background, /tabIds: \[tabId\]/, 'the condition must name the tab');
    assert.match(background, /rulesCarryOnlyTab/, 'and the installation must verify it kept that scope');
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

// --- what the settings reader makes of a stored profile -------------------

// The panel writes these values, but the reader is what decides what a profile means - including one
// written by an older build. 'immediate' was a separate mode before the wait accepted zero, so a
// profile holding it means "wait zero seconds", not "fall back to the default".
check('a removed mode is read as the zero wait it meant', () => {
    const source = read('src/content/index.js');
    const start = source.indexOf('function resolveSpentSettings');
    assert.ok(start !== -1, 'the settings reader must exist');

    const body = source.slice(start, source.indexOf('\n    }', start) + 6)
        .replace('function resolveSpentSettings', 'function resolveSpentSettings')
        .replace(/ZQ\.DEFAULT_SPENT_DELAY_SECONDS/g, '2')
        .replace(/ZQ\.SPENT_MODES/g, "['manual', 'press', 'delay']");

    const resolve = vm.runInNewContext('(' + body + ')', {});

    // Compared as plain data: an object built inside another vm realm has that realm's prototypes, and
    // a structural comparison of the two would be about the realms rather than about the values.
    const read2 = value => JSON.parse(JSON.stringify(value));

    assert.deepEqual(read2(resolve({ spentMode: 'immediate', spentDelaySeconds: 30 })),
        { spentMode: 'delay', spentDelaySeconds: 0 },
        'the old mode must not be dropped to the default, and its stale wait must not win');

    assert.deepEqual(read2(resolve({ spentMode: 'delay', spentDelaySeconds: 0 })),
        { spentMode: 'delay', spentDelaySeconds: 0 },
        'zero must survive as zero');

    assert.deepEqual(read2(resolve({ spentMode: 'delay' })),
        { spentMode: 'delay', spentDelaySeconds: 2 },
        'an absent wait falls back to the default');

    assert.deepEqual(read2(resolve({ spentMode: 'nonsense' })),
        { spentMode: 'manual', spentDelaySeconds: 2 },
        'an unknown mode keeps the page rather than swapping it');
});

const failed = checks.filter(ok => !ok).length;
console.log('');
if (failed) {
    console.error(`${failed}/${checks.length} identity consistency checks failed`);
    process.exitCode = 1;
} else {
    console.log(`PASS: ${checks.length}/${checks.length} identity consistency checks`);
}
