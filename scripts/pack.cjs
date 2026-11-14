#!/usr/bin/env node

// Packs the repository for an external reviewer.
//
// The pack has to be a faithful copy of the checkout: every tracked file, byte for byte, plus
// .git so the reviewer can read the history and apply a patch against a real base. It replaces
// a shell one-liner that copied `dir/*` into a staging folder and zipped that, which silently
// dropped every dotfile - `.gitattributes` and `.gitignore` never reached a reviewer.
//
// That omission is not cosmetic here: `.gitattributes` sets `* -text`, and this repository has
// real CRLF content. A pack without it restores with mangled line endings, which is exactly the
// class of bug the reviewer already had to correct once.
//
//   node scripts/pack.cjs [--out <file.zip>]
//
// Files come from `git ls-files`, so what is packed is what is tracked - no build output, no
// stray scratch files, and nothing skipped because its name starts with a dot.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function arg(name, fallback) {
    const index = process.argv.indexOf('--' + name);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const out = path.resolve(arg('out', path.join(os.homedir(), 'Desktop', 'tencent-ai-detect.zip')));

function git(args, options = {}) {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
}

const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
if (!tracked.length) throw new Error('nothing is tracked; refusing to pack an empty archive');

// A tracked file that is missing from disk means the checkout is dirty in a way that would
// produce a pack quietly different from the commit it claims to be.
const missing = tracked.filter(file => !fs.existsSync(path.join(ROOT, file)));
if (missing.length) throw new Error('tracked but absent from disk: ' + missing.join(', '));

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'zq-pack-'));

try {
    for (const file of tracked) {
        const to = path.join(stage, file);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(path.join(ROOT, file), to);
    }

    // The reviewer applies patches against a real base, so the history travels with the source.
    fs.cpSync(path.join(ROOT, '.git'), path.join(stage, '.git'), { recursive: true });

    if (fs.existsSync(out)) fs.rmSync(out);

    // Compress-Archive is the only zip writer available on a stock Windows box; on anything else
    // the system `zip` is used. Both get the staging directory as their root.
    const isWindows = process.platform === 'win32';
    if (isWindows) {
        execFileSync('powershell', [
            '-NoProfile', '-Command',
            `Compress-Archive -Path '${path.join(stage, '*')}' -DestinationPath '${out}' -Force`
        ], { stdio: 'inherit' });
    } else {
        execFileSync('zip', ['-r', '-q', out, '.'], { cwd: stage, stdio: 'inherit' });
    }
} finally {
    fs.rmSync(stage, { recursive: true, force: true });
}

// Read the archive back instead of trusting the writer: the whole defect being fixed here was a
// pack that looked fine and was silently incomplete.
const listing = process.platform === 'win32'
    ? execFileSync('powershell', ['-NoProfile', '-Command',
        `Add-Type -A System.IO.Compression.FileSystem; ` +
        `[IO.Compression.ZipFile]::OpenRead('${out}').Entries | ForEach-Object { $_.FullName }`,
    ], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
    : execFileSync('unzip', ['-Z1', out], { encoding: 'utf8' }).split('\n').filter(Boolean);

const packed = new Set(listing.map(entry => entry.replace(/\\/g, '/')));
const absent = tracked.filter(file => !packed.has(file));
if (absent.length) throw new Error('tracked but absent from the archive: ' + absent.join(', '));

const dotfiles = tracked.filter(file => path.basename(file).startsWith('.'));
const dotfilesPacked = dotfiles.filter(file => packed.has(file));

process.stdout.write('packed    ' + tracked.length + ' tracked files -> ' + out + '\n');
process.stdout.write('dotfiles  ' + dotfilesPacked.length + '/' + dotfiles.length
    + (dotfiles.length ? ' (' + dotfiles.join(', ') + ')' : '') + '\n');
process.stdout.write('history   ' + (packed.has('.git/HEAD') ? 'included' : 'MISSING') + '\n');
process.stdout.write('size      ' + (fs.statSync(out).size / 1024 / 1024).toFixed(1) + ' MB\n');
