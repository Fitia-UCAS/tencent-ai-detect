// Offline unit checks. The real OS ownership lookup is Windows-only and must
// still be verified with a live Edge/Native Host session.
const assert = require('node:assert/strict');
const { relayPidForPort, existingScripts } = require('../../tools/find-relay-pid.cjs');

let seen = null;
const fake = stdout => (name, args, opts) => {
    seen = { name, args, opts };
    return { status: 0, stdout };
};
assert.equal(relayPidForPort(9420, { platform: 'linux', spawnSync: fake('123\n') }), null);
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
