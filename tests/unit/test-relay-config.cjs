// The relay's two settings: how long it waits before exiting, and which way it leaves the machine.
//
// The second one matters more than it looks. The captcha ticket is issued for the address the page
// reached the server from, and the detection socket has to arrive from that same address or the
// server answers "Invalid request" every time, naming none of its inputs. With a proxy switched on,
// the page follows it and a bare net.connect() does not, so the two addresses diverge. The relay
// therefore follows the proxy - and how it finds out has to work on a machine that is not the one
// this was written on, which is why the standard environment variables come first.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    resolveIdleTimeout,
    resolveProxy,
    parseProxy,
    proxyFromEnvironment,
    readWindowsProxy,
    readMacProxy,
    describeProxy,
    createProxyWatcher
} = require('../../src/relay/config.cjs');

const checks = [];
const check = (name, fn) => {
    try {
        fn();
        checks.push(true);
        console.log('  ok    ' + name);
    } catch (error) {
        checks.push(false);
        console.log('  FAIL  ' + name + ' — ' + error.message);
    }
};

// --- idle timeout ---------------------------------------------------------

check('the idle timeout defaults to two minutes', () => {
    assert.equal(resolveIdleTimeout({}), 120000);
    assert.equal(resolveIdleTimeout({ RELAY_IDLE_MS: '' }), 120000);
});

check('zero disables the idle exit instead of being read as absent', () => {
    assert.equal(resolveIdleTimeout({ RELAY_IDLE_MS: '0' }), 0);
});

check('a bad idle timeout is refused rather than silently defaulted', () => {
    assert.throws(() => resolveIdleTimeout({ RELAY_IDLE_MS: '-1' }), /non-negative/);
    assert.throws(() => resolveIdleTimeout({ RELAY_IDLE_MS: 'not-a-number' }), /non-negative/);
});

// --- address shapes -------------------------------------------------------

check('the plain host:port form is read', () => {
    assert.deepEqual(parseProxy('127.0.0.1:7897'), { host: '127.0.0.1', port: 7897 });
});

check('a scheme prefix is stripped, whatever it is', () => {
    assert.deepEqual(parseProxy('http://127.0.0.1:7897'), { host: '127.0.0.1', port: 7897 });
    assert.deepEqual(parseProxy('socks5://10.0.0.2:1080'), { host: '10.0.0.2', port: 1080 });
});

check('a bracketed IPv6 address keeps its host', () => {
    assert.deepEqual(parseProxy('[::1]:7897'), { host: '::1', port: 7897 });
});

check('the Windows multi-protocol form takes the https entry first', () => {
    assert.deepEqual(
        parseProxy('http=127.0.0.1:7897;https=127.0.0.1:7898;socks=127.0.0.1:7899'),
        { host: '127.0.0.1', port: 7898 });
});

check('anything meaning "direct" reads as direct', () => {
    for (const value of ['', '   ', 'off', 'OFF', 'none', 'direct', 'false', '0', null, undefined]) {
        assert.equal(parseProxy(value), null, JSON.stringify(value) + ' must mean direct');
    }
});

check('an unparseable value reads as direct rather than throwing', () => {
    for (const value of ['nonsense', 'host:', ':7897', 'host:notaport', 'host:0']) {
        assert.equal(parseProxy(value), null, JSON.stringify(value) + ' must mean direct');
    }
});

// --- environment variables ------------------------------------------------

check('the standard environment variables are honoured', () => {
    assert.deepEqual(proxyFromEnvironment({ https_proxy: '127.0.0.1:1080' }),
        { host: '127.0.0.1', port: 1080 });
    assert.deepEqual(proxyFromEnvironment({ HTTPS_PROXY: '127.0.0.1:1081' }),
        { host: '127.0.0.1', port: 1081 });
    assert.deepEqual(proxyFromEnvironment({ all_proxy: 'socks://127.0.0.1:1082' }),
        { host: '127.0.0.1', port: 1082 });
});

check('the lower-case spelling wins, as curl and Node do it', () => {
    assert.deepEqual(
        proxyFromEnvironment({ https_proxy: '127.0.0.1:1111', HTTPS_PROXY: '127.0.0.1:2222' }),
        { host: '127.0.0.1', port: 1111 });
});

check('an environment with nothing set means direct', () => {
    assert.equal(proxyFromEnvironment({}), null);
});

// --- resolution order -----------------------------------------------------

check('RELAY_PROXY overrides everything, including the platform switch', () => {
    const platform = {
        regQuery: () => 'ProxyEnable    REG_DWORD    0x1\r\nProxyServer    REG_SZ    127.0.0.1:7897\r\n'
    };
    assert.deepEqual(
        resolveProxy({ RELAY_PROXY: '10.1.1.1:3128', https_proxy: '127.0.0.1:1080' }, platform),
        { host: '10.1.1.1', port: 3128 });
});

check('RELAY_PROXY=off forces a direct connection', () => {
    const platform = {
        regQuery: () => 'ProxyEnable    REG_DWORD    0x1\r\nProxyServer    REG_SZ    127.0.0.1:7897\r\n'
    };
    assert.equal(resolveProxy({ RELAY_PROXY: 'off' }, platform), null);
});

check('the environment beats the platform switch', () => {
    const platform = {
        regQuery: () => 'ProxyEnable    REG_DWORD    0x1\r\nProxyServer    REG_SZ    127.0.0.1:7897\r\n'
    };
    assert.deepEqual(resolveProxy({ https_proxy: '127.0.0.1:1080' }, platform),
        { host: '127.0.0.1', port: 1080 });
});

// --- platform switches ----------------------------------------------------

check('the Windows switch is read only when it is on', () => {
    const on = 'ProxyEnable    REG_DWORD    0x1\r\nProxyServer    REG_SZ    127.0.0.1:7897\r\n';
    assert.deepEqual(readWindowsProxy(() => on), { host: '127.0.0.1', port: 7897 });

    const off = on.replace('0x1', '0x0');
    assert.equal(readWindowsProxy(() => off), null, 'an off switch means direct, not the old address');
});

check('a PAC script is not guessed at', () => {
    const pac = 'ProxyEnable    REG_DWORD    0x1\r\nProxyServer    REG_SZ    127.0.0.1:7897\r\n' +
        'AutoConfigURL    REG_SZ    http://example/p.pac\r\n';
    assert.equal(readWindowsProxy(() => pac), null);
});

check('the macOS switch is read from scutil output', () => {
    const scutil = [
        '<dictionary> {',
        '  HTTPEnable : 0',
        '  HTTPSEnable : 1',
        '  HTTPSProxy : 127.0.0.1',
        '  HTTPSPort : 7897',
        '}'
    ].join('\n');
    assert.deepEqual(readMacProxy(() => scutil), { host: '127.0.0.1', port: 7897 });

    assert.equal(readMacProxy(() => '  HTTPSEnable : 0\n  HTTPSProxy : 127.0.0.1\n  HTTPSPort : 7897'),
        null);
});

check('a platform that cannot answer resolves to direct', () => {
    assert.equal(readWindowsProxy(() => { throw new Error('reg is not on this machine'); }), null);
    assert.equal(readMacProxy(() => { throw new Error('scutil is not on this machine'); }), null);
    assert.equal(readWindowsProxy(() => ''), null);
});

// --- what the startup line reports ---------------------------------------

check('the outbound path is named in the startup line, so a mismatch can be seen', () => {
    assert.equal(describeProxy({ host: '127.0.0.1', port: 7897 }), '127.0.0.1:7897');
    assert.equal(describeProxy(null), 'direct');
});

// --- the path is re-read while the relay runs ----------------------------

// The page re-reads the system switch for every request; a relay that reads it once keeps the path it
// started with, so flipping the proxy leaves one half on the proxy and the other direct - the pair of
// addresses the server refuses as "Invalid request", with nothing in either log saying so.
check('a flipped switch is picked up without restarting the relay', () => {
    let answer = { host: '127.0.0.1', port: 7897 };
    let clock = 1000;

    const outbound = createProxyWatcher({
        resolve: () => answer,
        now: () => clock,
        ttlMs: 5000
    });

    assert.deepEqual(outbound.current(), { host: '127.0.0.1', port: 7897 });

    // Clash switched off: the browser stops using it immediately.
    answer = null;
    clock += 5000;
    assert.equal(outbound.current(), null, 'the relay must follow the switch, not its startup path');

    answer = { host: '127.0.0.1', port: 7899 };
    clock += 5000;
    assert.deepEqual(outbound.current(), { host: '127.0.0.1', port: 7899 },
        'a different proxy address is followed too');
});

check('the switch is not re-read for every connection', () => {
    let reads = 0;
    let clock = 1000;

    const outbound = createProxyWatcher({
        resolve: () => { reads += 1; return null; },
        now: () => clock,
        ttlMs: 5000
    });

    for (let i = 0; i < 20; i += 1) {
        clock += 100;
        outbound.current();
    }

    // Reading the switch spawns a process on Windows, which must not happen per frame.
    assert.ok(reads <= 2, 'expected the answer to be reused within the window, read ' + reads + ' times');
});

check('a change is reported once, with both ends', () => {
    const changes = [];
    let answer = { host: '127.0.0.1', port: 7897 };
    let clock = 1000;

    const outbound = createProxyWatcher({
        resolve: () => answer,
        now: () => clock,
        ttlMs: 5000,
        onChange: (next, before) => changes.push([describeProxy(before), describeProxy(next)])
    });

    outbound.current();
    assert.equal(changes.length, 0, 'the first answer is the startup line, not a change');

    answer = null;
    clock += 5000;
    outbound.current();
    outbound.current();
    assert.deepEqual(changes, [['127.0.0.1:7897', 'direct']],
        'one line per change, so the log stays readable');
});

// The watcher is only worth having if the relay asks it. Pinned at the source, because the relay is a
// script rather than a module: reintroducing a module-level constant would silently restore the
// startup-only behaviour that this whole section exists to remove.
check('the relay reads the switch when it dials, not when it starts', () => {
    const relay = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'relay', 'server.cjs'), 'utf8');

    assert.doesNotMatch(relay, /^const PROXY = resolveProxy\(\);/m,
        'a path resolved at module load is the defect this watcher removes');

    const dialAt = relay.indexOf('function dialUpstream');
    assert.ok(dialAt !== -1, 'the dial must be its own function');
    assert.match(relay.slice(dialAt, dialAt + 400), /outbound\.current\(\)/,
        'the dial must ask for the current path');
});

const failed = checks.filter(ok => !ok).length;
console.log('');
if (failed) {
    console.error(`${failed}/${checks.length} relay configuration checks failed`);
    process.exitCode = 1;
} else {
    console.log(`PASS: ${checks.length}/${checks.length} relay configuration checks`);
}
