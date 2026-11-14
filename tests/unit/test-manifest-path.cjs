// Verifies the native host manifest is generated from the template, so the repository never
// carries an absolute launcher path and a relocated checkout still registers correctly.
//
// The generated file must also live outside the checkout. It used to be written into host/ and was
// therefore owned by whichever branch was checked out: switching branches removed the file while
// the registry kept pointing at it, the host then failed to start, and the extension silently did
// nothing on every branch. ZQ_KEY_DIR redirects the output here so the test never touches the real
// registration.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const from = path.resolve(__dirname, '..', '..', 'host');
const template = JSON.parse(fs.readFileSync(path.join(from, 'nm-manifest.template.json'), 'utf8'));

// The template itself must not contain a machine-specific path.
assert.equal(template.path, '__LAUNCHER__', 'template must keep the placeholder, not a real path');
assert.ok(!JSON.stringify(template).includes('edge-extensions'), 'template must not name a checkout');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-manifest-test-'));
// Two separate directories, mirroring the real layout: the checkout and the per-user state folder.
const checkout = path.join(temp, 'checkout');
const stateDir = path.join(temp, 'state');
const manifestPath = path.join(stateDir, 'nm-manifest.json');
const env = { ...process.env, ZQ_KEY_DIR: stateDir };

try {
    fs.mkdirSync(checkout, { recursive: true });
    for (const name of ['nm-host.bat', 'nm-manifest.template.json', 'register-manifest.cjs']) {
        fs.copyFileSync(path.join(from, name), path.join(checkout, name));
    }

    // No generated manifest is copied in: registration must create it from the template.
    const run = spawnSync(process.execPath, [path.join(checkout, 'register-manifest.cjs')], { encoding: 'utf8', env });
    assert.equal(run.status, 0, run.stderr || run.stdout);

    assert.ok(fs.existsSync(manifestPath), 'manifest must be written to the state directory');
    assert.ok(
        !fs.existsSync(path.join(checkout, 'nm-manifest.json')),
        'manifest must not be written into the checkout'
    );

    const actual = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(actual.path, path.join(checkout, 'nm-host.bat'), 'path must follow the checkout location');
    assert.deepEqual(actual.allowed_origins, template.allowed_origins);
    assert.equal(actual.name, template.name);
    assert.equal(actual.type, 'stdio');

    // Running it again must be idempotent rather than appending anything.
    const again = spawnSync(process.execPath, [path.join(checkout, 'register-manifest.cjs')], { encoding: 'utf8', env });
    assert.equal(again.status, 0, again.stderr || again.stdout);
    const second = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.deepEqual(second, actual, 'regeneration must not change the result');

    // The working branch must not track the generated file, so a checkout cannot delete it. main is
    // the frozen baseline and is deliberately left alone: it still tracks a machine-specific
    // manifest under host/nm-manifest.json, which is part of why the two branches disagreed.
    const tracked = spawnSync('git', ['ls-tree', '-r', '--name-only', 'dev'], { cwd: from, encoding: 'utf8' });
    if (tracked.status === 0) {
        const trackedFiles = String(tracked.stdout).split(/\r?\n/);
        assert.ok(
            !trackedFiles.some(f => /nm-manifest\.(local\.)?json$/.test(f) && !f.endsWith('.template.json')),
            'dev must not track a generated manifest'
        );
    }

    // Ask the script where it would write, so a future refactor that reintroduces an in-tree path is
    // caught even if it uses a different filename. Requiring it also prints a status line, so only
    // the last line is the reported path.
    const asked = spawnSync(
        process.execPath,
        ['-e', `console.log(require(${JSON.stringify(path.join(checkout, 'register-manifest.cjs'))}).outputPath)`],
        { encoding: 'utf8', env }
    );
    assert.equal(asked.status, 0, asked.stderr || asked.stdout);
    const reported = asked.stdout.trim().split(/\r?\n/).pop();
    assert.equal(path.resolve(reported), path.resolve(manifestPath));
    assert.ok(
        !path.resolve(reported).startsWith(path.resolve(checkout) + path.sep),
        'the reported output path must sit outside the checkout'
    );

    console.log('PASS: Native Host manifest generated from template, outside the checkout');
} finally {
    fs.rmSync(temp, { recursive: true, force: true });
}
