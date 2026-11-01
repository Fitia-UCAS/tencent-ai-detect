// Verifies relocation-safe manifest regeneration without modifying host config.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const from = path.resolve(__dirname, '..', 'host');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-manifest-test-'));
try {
  for (const name of ['nm-host.bat', 'nm-manifest.json', 'update-manifest.cjs']) {
    fs.copyFileSync(path.join(from, name), path.join(temp, name));
  }
  const initial = JSON.parse(fs.readFileSync(path.join(temp, 'nm-manifest.json'), 'utf8'));
  const run = spawnSync(process.execPath, [path.join(temp, 'update-manifest.cjs')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const actual = JSON.parse(fs.readFileSync(path.join(temp, 'nm-manifest.json'), 'utf8'));
  assert.equal(actual.path, path.join(temp, 'nm-host.bat'));
  assert.deepEqual(actual.allowed_origins, initial.allowed_origins);
  assert.equal(actual.name, initial.name);
  console.log('PASS: Native Host manifest path updated without changing origin list');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
