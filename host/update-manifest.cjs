// Resolve the launcher path on this machine before registering the native host.
// Keeps the installed extension ID and other manifest fields unchanged.
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
const file = path.join(dir, 'nm-manifest.json');
const launcher = path.resolve(dir, 'nm-host.bat');
if (!fs.existsSync(launcher)) throw new Error('native host launcher not found');
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.path = launcher;
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log('Native Host manifest path updated:', launcher);
