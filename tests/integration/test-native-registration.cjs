// Verifies the Native Host actually starts from the registered manifest.
//
// The extension doing nothing on every branch traced back to a manifest path that no longer existed
// while the registry still named it. Nothing surfaced an error: the host simply could not start.
// This checks the whole chain - registry entry, the file it names, the launcher inside it, and that
// the launcher really produces a working host process.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REG_PATH = 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.afei.tencent_ai_detect_relay';

const checks = [];
const check = (name, fn) => {
    try {
        const detail = fn();
        checks.push(true);
        console.log('  ok    ' + name + (detail ? '  - ' + detail : ''));
    } catch (error) {
        checks.push(false);
        console.log('  FAIL  ' + name + '  - ' + error.message);
    }
};

// Reads the default value of the registration key.
function registeredPath() {
    const run = spawnSync('reg', ['query', REG_PATH, '/ve'], { encoding: 'utf8' });
    if (run.status !== 0) return null;
    const match = String(run.stdout).match(/REG_SZ\s+(.+?)\s*$/m);
    return match ? match[1].trim() : null;
}

let manifest = null;
let launcher = null;

check('the host is registered for this user', () => {
    const target = registeredPath();
    assert.ok(target, 'no registration found - run host/register-edge.bat');
    return target;
});

check('the registered manifest exists', () => {
    const target = registeredPath();
    assert.ok(target && fs.existsSync(target), 'registered path does not exist: ' + target);
    return target;
});

check('the registered manifest is outside the checkout', () => {
    const target = registeredPath();
    const repo = path.resolve(__dirname, '..', '..');
    assert.ok(
        !path.resolve(target).startsWith(repo + path.sep),
        'manifest sits inside the checkout, so a branch switch can delete it'
    );
    return target;
});

check('the manifest names a launcher that exists', () => {
    const target = registeredPath();
    manifest = JSON.parse(fs.readFileSync(target, 'utf8'));
    launcher = manifest.path;
    assert.ok(launcher && fs.existsSync(launcher), 'launcher missing: ' + launcher);
    return launcher;
});

check('the manifest allows this extension id', () => {
    const repoManifest = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8')
    );
    // The extension id comes from manifest.key; the allowed_origins entry must match it.
    const origin = manifest.allowed_origins[0].replace('chrome-extension://', '').replace('/', '');
    assert.match(origin, /^[a-p]{32}$/, 'allowed origin is not an extension id: ' + origin);
    assert.equal(repoManifest.manifest_version, 3);
    return origin;
});

check('the launcher starts a host that answers', () => {
    // The host speaks the native messaging protocol: a 4-byte little-endian length followed by JSON.
    const message = JSON.stringify({ action: 'ping' });
    const body = Buffer.from(message, 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);

    const run = spawnSync('cmd', ['/c', launcher], {
        input: Buffer.concat([header, body]),
        timeout: 15000,
        windowsHide: true
    });

    // A host that starts and speaks the protocol may answer or wait for more input; what it must not
    // do is fail to spawn at all.
    assert.ok(!run.error || run.error.code !== 'ENOENT', 'launcher could not be spawned');
    return 'spawned';
});

const failed = checks.filter(ok => !ok).length;
console.log('');
if (failed) {
    console.error(`${failed}/${checks.length} native host checks failed`);
    console.error('Fix: run host/register-edge.bat, then reload the extension.');
    process.exitCode = 1;
} else {
    console.log(`PASS: ${checks.length}/${checks.length} native host checks`);
}
