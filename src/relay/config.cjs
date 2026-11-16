// Process-level settings for the relay.
//
// Kept in one file because the same values are read by two processes: the relay itself and, for the
// port, the native host that waits for it to come up.

const { execFileSync } = require('node:child_process');

const WINDOWS_INTERNET_SETTINGS =
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

// Environment variables, in the order the HTTP tooling on every platform agrees on. A lower-case
// spelling beats the upper-case one, which is what curl and Node's own conventions do.
const PROXY_ENV_KEYS = [
    'https_proxy', 'HTTPS_PROXY',
    'http_proxy', 'HTTP_PROXY',
    'all_proxy', 'ALL_PROXY'
];

function resolveIdleTimeout(env = process.env) {
    const raw = env.RELAY_IDLE_MS;
    if (raw === undefined || raw === '') return 120000;

    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
        throw new RangeError('RELAY_IDLE_MS must be a non-negative number');
    }
    return value;
}

// Parses the shapes a proxy address arrives in: "host:port", "http://host:port", and the Windows
// multi-protocol form "http=host:port;https=host:port". Returns null for anything that means
// "connect directly", including the empty string.
function parseProxy(raw) {
    if (raw === undefined || raw === null) return null;

    const text = String(raw).trim();
    if (!text || /^(off|none|direct|false|0)$/i.test(text)) return null;

    const entries = new Map();
    for (const part of text.split(';')) {
        if (!part.trim()) continue;
        const split = part.indexOf('=');
        const key = split === -1 ? 'default' : part.slice(0, split).trim().toLowerCase();
        const value = split === -1 ? part.trim() : part.slice(split + 1).trim();
        if (value) entries.set(key, value);
    }

    const chosen = entries.get('https') || entries.get('http') || entries.get('default');
    if (!chosen) return null;

    const withoutScheme = chosen.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    const separator = withoutScheme.lastIndexOf(':');
    if (separator < 1) return null;

    const host = withoutScheme.slice(0, separator).replace(/^\[|\]$/g, '').trim();
    const port = Number(withoutScheme.slice(separator + 1).trim());
    if (!host || !Number.isInteger(port) || port <= 0) return null;

    return { host, port };
}

function proxyFromEnvironment(env) {
    for (const key of PROXY_ENV_KEYS) {
        const raw = env[key];
        if (raw) {
            const parsed = parseProxy(raw);
            if (parsed) return parsed;
        }
    }
    return null;
}

// Windows keeps the system proxy switch and its address in the registry, and the browser follows
// that switch while a bare net.connect() never does. Both the HTTP and the HTTPS entry are usually
// the same listener (Clash, v2rayN and the like expose one mixed port), so either will do.
//
// A PAC script is deliberately not honoured: resolving it means fetching and interpreting
// JavaScript, and guessing wrong here is worse than staying direct.
function readWindowsProxy(runRegQuery) {
    let output;
    try {
        output = runRegQuery();
    } catch (error) {
        return null;
    }
    if (!output) return null;

    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(output)) return null;
    if (/AutoConfigURL\s+REG_SZ\s+\S/i.test(output)) return null;

    const server = output.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
    return server ? parseProxy(server[1]) : null;
}

function queryWindowsProxy() {
    return execFileSync('reg', ['query', WINDOWS_INTERNET_SETTINGS], {
        encoding: 'utf8',
        windowsHide: true
    });
}

// macOS exposes the same switch through scutil. The output is a flat block of "Key : value" lines
// with the enabled ones marked "1".
function readMacProxy(runScutil) {
    let output;
    try {
        output = runScutil();
    } catch (error) {
        return null;
    }
    if (!output) return null;

    for (const [enabled, host, port] of [
        ['HTTPSEnable', 'HTTPSProxy', 'HTTPSPort'],
        ['HTTPEnable', 'HTTPProxy', 'HTTPPort']
    ]) {
        if (!new RegExp(`^\\s*${enabled}\\s*:\\s*1\\s*$`, 'm').test(output)) continue;

        const address = output.match(new RegExp(`^\\s*${host}\\s*:\\s*(\\S+)\\s*$`, 'm'));
        const number = output.match(new RegExp(`^\\s*${port}\\s*:\\s*(\\d+)\\s*$`, 'm'));
        if (address && number) return { host: address[1], port: Number(number[1]) };
    }
    return null;
}

function queryMacProxy() {
    return execFileSync('scutil', ['--proxy'], { encoding: 'utf8' });
}

// The outbound path the relay must take.
//
// The captcha ticket is signed for the address the page reached the server from, and the detection
// socket has to arrive from that same address or the server answers "Invalid request" every time.
// The page leaves through whatever proxy the system is configured with; a bare net.connect() always
// leaves directly. When a proxy is on, the two diverge, so the relay follows it.
//
// Resolution order, and every step degrades to a direct connection rather than throwing:
//   1. RELAY_PROXY, which is how a caller states the answer outright ("off" means direct);
//   2. the standard proxy environment variables, which every platform and HTTP tool shares;
//   3. the platform's own switch, because most people turn on a proxy client and never set a
//      variable. Only Windows and macOS have a readable switch; elsewhere step 2 is the whole story.
function resolveProxy(env = process.env, runtimes = {}) {
    const override = env.RELAY_PROXY;
    if (override !== undefined && override !== '') return parseProxy(override);

    const fromEnvironment = proxyFromEnvironment(env);
    if (fromEnvironment) return fromEnvironment;

    if (process.platform === 'win32') {
        return readWindowsProxy(runtimes.regQuery || queryWindowsProxy);
    }
    if (process.platform === 'darwin') {
        return readMacProxy(runtimes.scutil || queryMacProxy);
    }
    return null;
}

function describeProxy(proxy) {
    return proxy ? `${proxy.host}:${proxy.port}` : 'direct';
}

// How long a resolved path is trusted before the switch is read again.
const PROXY_RECHECK_MS = 5000;

// The path the relay should take, re-read while it runs.
//
// A proxy client is a toggle the user flips, and flipping it changes the path the page takes at once:
// the browser re-reads the system switch for every request, while this process used to read it once,
// at startup. Turn the proxy on and the page starts leaving through it while the socket kept leaving
// directly - two addresses for one ticket, which the server refuses as "Invalid request" - and turn it
// off and the relay keeps tunnelling into a port nobody is listening on. Whether the relay happened to
// start before or after the flip then decides whether a detection works, which is what made this look
// like an intermittent fault.
//
// The recheck is throttled rather than per connection because reading the switch spawns a process on
// Windows, and because a proxy client that is being switched is not a sub-second event.
function createProxyWatcher({
    resolve = () => resolveProxy(),
    ttlMs = PROXY_RECHECK_MS,
    now = () => Date.now(),
    onChange = () => {}
} = {}) {
    let resolved;
    let checkedAt = 0;

    return {
        current() {
            const at = now();
            if (resolved !== undefined && at - checkedAt < ttlMs) return resolved;

            const next = resolve();
            checkedAt = at;

            const first = resolved === undefined;
            const before = resolved;
            resolved = next;

            // The first answer is not a change: the startup line already carries it.
            if (!first && describeProxy(before) !== describeProxy(next)) onChange(next, before);

            return resolved;
        }
    };
}

module.exports = {
    resolveIdleTimeout,
    resolveProxy,
    parseProxy,
    proxyFromEnvironment,
    readWindowsProxy,
    readMacProxy,
    describeProxy,
    createProxyWatcher,
    PROXY_RECHECK_MS,
    WINDOWS_INTERNET_SETTINGS
};
