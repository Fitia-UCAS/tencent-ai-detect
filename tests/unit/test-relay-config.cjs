// The relay's two settings: how long it waits before exiting, and which way it leaves the machine.
//
// The second one matters more than it looks. The captcha ticket is issued for the address the page
// reached the server from, and the detection socket has to arrive from that same address or the
// server answers "Invalid request" every time, naming none of its inputs. With a proxy switched on,
// the page follows it and a bare net.connect() does not, so the two addresses diverge. The relay
// therefore follows the proxy - and how it finds out has to work on a machine that is not the one
// this was written on, which is why the standard environment variables come first.
const assert = require('node:assert/strict');
const {
    resolveIdleTimeout,
    resolveProxy,
    parseProxy,
    proxyFromEnvironment,
    readWindowsProxy,
    readMacProxy,
    describeProxy
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

const failed = checks.filter(ok => !ok).length;
console.log('');
if (failed) {
    console.error(`${failed}/${checks.length} relay configuration checks failed`);
    process.exitCode = 1;
} else {
    console.log(`PASS: ${checks.length}/${checks.length} relay configuration checks`);
}
