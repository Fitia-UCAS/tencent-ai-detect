// Builds the zip that gets published, as opposed to the one a reviewer is handed.
//
// scripts/pack.cjs packs every tracked file plus .git so a reviewer can read the history. That is
// the wrong archive to publish twice over: it ships the tests, the diagnostics and the whole history,
// and it carries nothing extra for whoever installs it.
//
// What ships is what the browser and the native host need to run, and nothing else. The file list is
// derived from manifest.json rather than written out here, so adding a content script or a side panel
// asset to the manifest cannot leave the published zip missing it - the failure mode would be a
// published extension that loads and then does nothing.
//
//   node scripts/pack-release.cjs [--out <file.zip>]
//
// The zip is written outside the checkout by default, since an archive of the tree should not become
// part of the tree.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { buildZip } = require('./zip-writer.cjs');
const { listZip } = require('./zip-reader.cjs');

const ROOT = path.resolve(__dirname, '..');

function arg(name, fallback) {
    const index = process.argv.indexOf('--' + name);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version;
const out = path.resolve(arg('out', path.join(os.homedir(), 'Desktop', `tencent-ai-detect-v${version}.zip`)));

// --- what the extension itself loads ------------------------------------------------------------

const wanted = new Set(['manifest.json']);

for (const size of Object.keys(manifest.icons || {})) wanted.add(manifest.icons[size]);
for (const size of Object.keys((manifest.action && manifest.action.default_icon) || {})) {
    wanted.add(manifest.action.default_icon[size]);
}
if (manifest.side_panel && manifest.side_panel.default_path) wanted.add(manifest.side_panel.default_path);
if (manifest.background && manifest.background.service_worker) wanted.add(manifest.background.service_worker);

for (const entry of manifest.content_scripts || []) {
    for (const file of entry.js || []) wanted.add(file);
    for (const file of entry.css || []) wanted.add(file);
}

// --- what the native host and the relay load next -------------------------------------------------

// The directories that hold running code as a whole. Listing individual files here would go stale
// the first time a module is added, and the resulting zip would fail at runtime rather than at pack.
const RUNTIME_DIRS = ['src', 'host'];

// The host is started by the browser as `node host/nm-host.bat`, and that script points at
// src/host/native-host.cjs; the relay lives in src/relay and is spawned by the host. All of it is
// inside RUNTIME_DIRS, so nothing extra is needed beyond keeping those two trees whole.
function addTree(dir) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) return;

    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
        const rel = path.posix.join(dir, entry.name);
        if (entry.isDirectory()) {
            addTree(rel);
        } else {
            wanted.add(rel);
        }
    }
}

for (const dir of RUNTIME_DIRS) addTree(dir);

// Read by a person, and the licence is the reason the terms of use are not a surprise later.
for (const extra of ['LICENSE', 'README.md']) {
    if (fs.existsSync(path.join(ROOT, extra))) wanted.add(extra);
}

// --- the archive is only as good as what is in it -------------------------------------------------

const files = [...wanted].sort();

const missing = files.filter(file => !fs.existsSync(path.join(ROOT, file)));
if (missing.length) {
    // A manifest entry with no file behind it is a broken extension that still installs, so this
    // stops the build instead of producing an archive that looks fine.
    process.stderr.write('these are referenced but absent from disk:\n');
    for (const file of missing) process.stderr.write('  ' + file + '\n');
    process.exit(1);
}

if (files.length < 10) {
    process.stderr.write(`only ${files.length} file(s) selected; the manifest was probably not read\n`);
    process.exit(1);
}

for (const file of files) {
    // The one mistake that would leak a checkout's history into a published download.
    if (/(^|\/)\.git(\/|$)/.test(file) || /\.zip$/.test(file)) {
        process.stderr.write('refusing to pack ' + file + '\n');
        process.exit(1);
    }
}

// --- write it ------------------------------------------------------------------------------------

// Lists the archive's entries without depending on a zip library or an external tool.
//
// Both alternatives were tried and both broke: `tar -tf` here is GNU tar from Git Bash, which reads
// the colon in C:\... as a remote host, and PowerShell's reader is absent on the Ubuntu runner where
// the release is actually built. Reading the central directory directly behaves the same everywhere.
function listArchive(file) {
    return listZip(file).map(entry => entry.name);
}

function assertArchive(file, expected) {
    const listed = listArchive(file);
    const present = new Set(listed);

    const absent = expected.filter(name => !present.has(name));
    if (absent.length) {
        process.stderr.write('the archive is missing entries it was given:\n');
        for (const name of absent.slice(0, 10)) process.stderr.write('  ' + name + '\n');
        fs.rmSync(file, { force: true });
        process.exit(1);
    }

    const extra = listed.filter(name => !expected.includes(name));
    if (extra.length) {
        process.stderr.write('the archive holds files that were not selected:\n');
        for (const name of extra.slice(0, 10)) process.stderr.write('  ' + name + '\n');
        fs.rmSync(file, { force: true });
        process.exit(1);
    }
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'zq-release-'));
try {
    for (const file of files) {
        const target = path.join(stage, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(ROOT, file), target);
    }

    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (fs.existsSync(out)) fs.rmSync(out);

    // Written directly rather than through a compressor: see scripts/zip-writer.cjs for what the two
    // available ones do to the layout. The archive is a faithful copy of `files`, at their paths.
    fs.writeFileSync(out, buildZip(ROOT, files));

    // Reading it back is the only check that means anything: it catches a flattened archive, a
    // missing file and a path written with the wrong separator in one pass.
    assertArchive(out, files);
} finally {
    // Nothing was staged; the files are read straight from the checkout.
}

const size = fs.statSync(out).size;

process.stdout.write(`version : ${version}\n`);
process.stdout.write(`files   : ${files.length}\n`);
process.stdout.write(`archive : ${out}  (${(size / 1024).toFixed(0)} KB)\n`);
process.stdout.write('\ncontents:\n');
for (const file of files) process.stdout.write('  ' + file + '\n');
