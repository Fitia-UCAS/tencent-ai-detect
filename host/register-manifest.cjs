// Generate the native messaging host manifest outside the repository.
//
// The browser requires an absolute launcher path here, so this file cannot be portable. Keeping it
// inside the checkout made it belong to whichever branch was checked out: switching branches
// removed the file while the registry kept pointing at it, and the host then failed to start with
// no visible error - the extension simply did nothing at all.
//
// It is written to %USERPROFILE%\.tencent-ai-detect-keys\ instead, beside the extension key, where
// no branch, checkout or clean can touch it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hostDir = __dirname;
const templatePath = path.join(hostDir, 'nm-manifest.template.json');

// Same directory the extension key lives in: outside every checkout, per-user.
const stateDir = process.env.ZQ_KEY_DIR || path.join(os.homedir(), '.tencent-ai-detect-keys');
const outputPath = path.join(stateDir, 'nm-manifest.json');

// The launcher is resolved from this script's own location, so a copied or relocated checkout
// produces the correct path without editing anything.
const launcher = path.resolve(hostDir, 'nm-host.bat');

if (!fs.existsSync(launcher)) {
    throw new Error('native host launcher not found: ' + launcher);
}

const manifest = JSON.parse(fs.readFileSync(templatePath, 'utf8'));

if (!manifest.path || !manifest.path.includes('__LAUNCHER__')) {
    throw new Error('template is missing the __LAUNCHER__ placeholder');
}

manifest.path = launcher;

fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log('Native Host manifest written: ' + outputPath);
console.log('  launcher: ' + launcher);

module.exports = { outputPath, launcher };
