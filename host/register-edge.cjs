// Registers the native messaging host for Microsoft Edge, per user.
//
// Run once after the extension is loaded unpacked, and again after moving this folder. Both steps
// live here on purpose: generating the manifest and pointing the registry at it are one operation,
// and having them in two files meant `npm run host:register` produced a manifest that the browser
// never found, because nothing wrote the key that makes it findable.
//
// The manifest itself is written outside the checkout, into the per-user key folder. The browser
// needs an absolute launcher path in it, and a file inside the tree belongs to whichever branch is
// checked out: switching branches removed it while the registry kept pointing at it, the host then
// failed to start, and the extension silently did nothing.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REG_ROOT = 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts';

if (process.platform !== 'win32') {
    process.stderr.write('This registers the host for Edge on Windows.\n');
    process.stderr.write('On macOS and Linux the browser reads a manifest from a directory instead.\n');
    process.exit(1);
}

// Generating the manifest is register-manifest.cjs's job; it reports where it wrote and what the
// launcher resolves to, so nothing here has to guess either.
const { outputPath, launcher } = require('./register-manifest.cjs');

if (!fs.existsSync(outputPath)) {
    process.stderr.write(`FAILED: manifest was not written to "${outputPath}"\n`);
    process.exit(1);
}

// The name the browser looks up is the one inside the manifest. Reading it from there keeps a single
// source of truth - the template - instead of a copy in this file that can drift from it.
const manifest = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
const name = manifest.name;

if (!name || manifest.path !== launcher) {
    process.stderr.write(`FAILED: "${outputPath}" is not a usable host manifest\n`);
    process.exit(1);
}

const regKey = `${REG_ROOT}\\${name}`;

try {
    execFileSync('reg', ['add', regKey, '/ve', '/t', 'REG_SZ', '/d', outputPath, '/f'], { stdio: 'pipe' });
} catch (error) {
    process.stderr.write(`FAILED to write ${regKey}\n`);
    process.stderr.write(String((error.stderr || '') + '') || String(error.message) + '\n');
    process.exit(1);
}

// Reading it back is the only proof the key holds what was intended; `reg add` succeeding says the
// command ran, not that the value is right. The value is parsed rather than echoed: reg.exe writes
// its labels in the console's own encoding, so printing them raw produces mojibake on a Chinese
// Windows, and the only part worth confirming is the ASCII path anyway.
let registered;
try {
    const raw = execFileSync('reg', ['query', regKey, '/ve'], { encoding: 'latin1' });
    const match = /REG_SZ\s+(.+?)\s*$/m.exec(raw);
    registered = match ? match[1] : null;
} catch (error) {
    process.stderr.write(`FAILED to read back ${regKey}\n`);
    process.exit(1);
}

if (registered !== outputPath) {
    process.stderr.write('FAILED: the registry holds a different path than the manifest just written\n');
    process.stderr.write(`  expected: ${outputPath}\n`);
    process.stderr.write(`  found   : ${registered || '(nothing)'}\n`);
    process.exit(1);
}

process.stdout.write(`Registered ${name}\n`);
process.stdout.write(`  registry : ${regKey}\n`);
process.stdout.write(`  manifest : ${outputPath}  (verified)\n`);
process.stdout.write(`  launcher : ${launcher}\n`);
process.stdout.write('\nReload the extension in edge://extensions for this to take effect.\n');
