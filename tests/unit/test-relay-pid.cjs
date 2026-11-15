// Offline unit checks. The real OS ownership lookup is verified with a live session on each
// platform; these check the parsing and the refusal cases.
const assert = require('node:assert/strict');
const { relayPidForPort, existingScripts } = require('../../tools/find-relay-pid.cjs');

let seen = null;
const fake = stdout => (name, args, opts) => {
    seen = { name, args, opts };
    return { status: 0, stdout };
};

// --- Linux ---------------------------------------------------------------------------------------
//
// /proc is injected rather than read, so these run on any platform and assert the parsing itself:
// the socket table, the fd symlinks and the process command line.
const TCP_HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
const listenLine = (hexPort, inode) =>
    `   0: 0100007F:${hexPort} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1\n`;

function linuxProc({ tcp = TCP_HEADER + listenLine('24CC', '55555'), tcp6 = TCP_HEADER, cmdline = {}, fds = {} } = {}) {
    const files = {
        '/proc/net/tcp': tcp,
        '/proc/net/tcp6': tcp6,
        ...Object.fromEntries(Object.entries(cmdline).map(([pid, value]) => [`/proc/${pid}/cmdline`, value]))
    };

    return {
        readFileSync(file) {
            if (files[file] === undefined) throw new Error('ENOENT ' + file);
            return files[file];
        },
        readdirSync(dir) {
            if (dir === '/proc') return Object.keys(fds);
            const pid = dir.match(/^\/proc\/(\d+)\/fd$/);
            if (pid && fds[pid[1]]) return Object.keys(fds[pid[1]]);
            throw new Error('ENOENT ' + dir);
        },
        readlinkSync(file) {
            const match = file.match(/^\/proc\/(\d+)\/fd\/(.+)$/);
            if (match && fds[match[1]] && fds[match[1]][match[2]] !== undefined) {
                return fds[match[1]][match[2]];
            }
            throw new Error('ENOENT ' + file);
        }
    };
}

const SCRIPT = '/checkout/src/relay/server.cjs';
const PORT = 9420; // 0x24CC
const asProcess = proc => relayPidForPort(PORT, { platform: 'linux', scriptPaths: [SCRIPT], ...proc });

const holder = (pid, entries = {}) => ({ [pid]: entries });

assert.equal(asProcess(linuxProc({
    cmdline: holder(4242, 'node\0' + SCRIPT + '\0'),
    fds: { 4242: { 0: '/dev/null', 3: 'socket:[55555]' } }
})), 4242, 'the listening socket is attributed to the process holding it');

assert.equal(asProcess(linuxProc({
    cmdline: holder(4242, 'node\0' + SCRIPT + '\0'),
    fds: { 4242: { 3: 'socket:[55555]' } }
})), 4242, 'file descriptors other than the socket are skipped');

assert.equal(relayPidForPort(9999, {
    platform: 'linux',
    scriptPaths: [SCRIPT],
    ...linuxProc({ cmdline: holder(4242, 'node\0' + SCRIPT + '\0'), fds: { 4242: { 3: 'socket:[55555]' } } })
}), null, 'a port with no listening socket is not attributed');

assert.equal(asProcess(linuxProc({
    tcp: TCP_HEADER + listenLine('24CC', '55555').replace(' 0A ', ' 01 '),
    cmdline: holder(4242, 'node\0' + SCRIPT + '\0'),
    fds: { 4242: { 3: 'socket:[55555]' } }
})), null, 'only LISTEN sockets count');

assert.equal(asProcess(linuxProc({
    cmdline: holder(4242, 'node\0/usr/lib/other-app/index.js\0'),
    fds: { 4242: { 3: 'socket:[55555]' } }
})), null, 'the process must have been started from the relay script');

assert.equal(asProcess(linuxProc({
    cmdline: { 4242: 'node\0' + SCRIPT + '\0', 4243: 'node\0' + SCRIPT + '\0' },
    fds: { 4242: { 3: 'socket:[55555]' }, 4243: { 3: 'socket:[55555]' } }
})), null, 'an ambiguous answer is reported as unattributed');

assert.equal(asProcess(linuxProc({
    cmdline: { 4242: 'node\0' + SCRIPT + '\0', 5555: 'node\0' + SCRIPT + '\0' },
    fds: { 5555: { 3: 'socket:[55555]' } }
})), 5555, 'a process that exits after the listing is skipped, not fatal');

assert.equal(asProcess(linuxProc({
    tcp: TCP_HEADER + listenLine('24CC', '0'),
    cmdline: holder(4242, 'node\0' + SCRIPT + '\0'),
    fds: { 4242: { 3: 'socket:[0]' } }
})), null, 'an unassigned inode is not a match');

// --- Windows -------------------------------------------------------------------------------------

assert.equal(relayPidForPort(9420, { platform: 'linux', spawnSync: fake('123\n') }), null, 'linux never shells out');
assert.equal(seen, null, 'the linux path spawns nothing');
assert.equal(relayPidForPort(0, { platform: 'win32', spawnSync: fake('123\n') }), null);
assert.equal(relayPidForPort(9420, { platform: 'win32', spawnSync: fake('123\n') }), 123);
assert.equal(seen.name, 'powershell');
assert(seen.args[3].includes('Get-NetTCPConnection'));
assert(seen.args[3].includes('Get-CimInstance'));

// The lookup must target the relay script this checkout actually contains, not a remembered
// path. Dev keeps it at src/relay/server.cjs and main at scripts/relay.cjs; resolving a single
// hard-coded tools/relay.cjs (which exists on neither) is what made the lookup return null for
// every caller on dev.
const scripts = existingScripts();
assert.ok(scripts.length > 0, 'this checkout must contain a relay script for the lookup to target');
for (const script of scripts) {
    assert.ok(
        seen.args[3].includes(script.replace(/'/g, "''")),
        'the lookup must target ' + script
    );
}

// The exact absolute-path alternative must evaluate Escape($target) as a
// PowerShell expression, not embed those characters inside a quoted regex.
assert(seen.args[3].includes("' + [regex]::Escape($target) + '"));
// Never allow an arbitrary drive-qualified checkout path to masquerade as ours.
assert(!seen.args[3].includes('[A-Za-z]:'));
// Preserve the manual relative spelling for both layouts (either slash style).
assert(seen.args[3].includes('scripts[\\\\/]relay\\.cjs'));
assert(seen.args[3].includes('src[\\\\/]relay[\\\\/]server\\.cjs'));

assert.equal(relayPidForPort(9420, { platform: 'win32', spawnSync: fake('111\n222\n') }), null);
assert.equal(relayPidForPort(9420, { platform: 'win32', spawnSync: fake('not a pid') }), null);
assert.equal(relayPidForPort(9420, { platform: 'win32', spawnSync: () => ({ status: 1, stdout: '123' }) }), null);
assert.equal(relayPidForPort(9420, { platform: 'win32', spawnSync: () => { throw Error('missing PS'); } }), null);
console.log('PASS: process-identity lookup rejects unverified and ambiguous results');
