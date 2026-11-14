#!/usr/bin/env node

// Produces the deliverables handed to an external reviewer.
//
// Filenames are fixed on purpose. Earlier rounds wrote snapshot-v2.txt,
// snapshot-v3.txt and a separate diff each time, so the desktop accumulated
// files and it stopped being obvious which ones were current. There are exactly
// two outputs now, both overwritten in place:
//
//   <desktop>/tencent-ai-detect-snapshot.txt   the full source snapshot
//   <desktop>/tencent-ai-detect-changes.md     per-file diff against the baseline
//
// The baseline lives in .baseline/snapshot-previous.txt and is only replaced
// when --accept-baseline is passed, so a diff can be regenerated reproducibly.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DESKTOP = process.env.DELIVER_DIR || path.join(os.homedir(), 'Desktop');
const SNAPSHOT_TOOL = process.env.SNAPSHOT_TOOL
    || path.join(DESKTOP, 'project-snapshot', 'scripts', 'project_snapshot.py');

const BASELINE_DIR = path.join(ROOT, '.baseline');
const BASELINE = path.join(BASELINE_DIR, 'snapshot-previous.txt');

const OUT_SNAPSHOT = path.join(DESKTOP, 'tencent-ai-detect-snapshot.txt');
const OUT_CHANGES = path.join(DESKTOP, 'tencent-ai-detect-changes.md');

const args = process.argv.slice(2);
const acceptBaseline = args.includes('--accept-baseline');

function run(command, argv) {
    const result = spawnSync(command, argv, { encoding: 'utf8' });

    if (result.status !== 0) {
        process.stderr.write(result.stdout || '');
        process.stderr.write(result.stderr || '');
        throw new Error(`${command} failed with code ${result.status}`);
    }

    return result.stdout || '';
}

function makeSnapshot(target) {
    run('python', [
        '-X', 'utf8', SNAPSHOT_TOOL, 'extract', ROOT,
        '--output', target,
        '--exclude-dir', '.git',
        '--exclude-dir', '.baseline',
        // Debug output from diagnostics (screenshots, DOM dumps, traces). It changes on every
        // diagnostic run, so shipping it in the snapshot only adds noise for the reviewer.
        '--exclude-dir', 'tmp-diag',
        '--exclude-file', '*.pem',
        '--force'
    ]);
}

fs.mkdirSync(BASELINE_DIR, { recursive: true });

// The baseline is the snapshot from the last accepted round. Without it there is
// nothing to diff against, so it is created from the current source.
makeSnapshot(OUT_SNAPSHOT);

if (!fs.existsSync(BASELINE)) {
    fs.copyFileSync(OUT_SNAPSHOT, BASELINE);
    process.stdout.write(`created baseline: ${path.relative(ROOT, BASELINE)}\n`);
}

let diff = '';

if (fs.existsSync(BASELINE)) {
    diff = run(process.execPath, [
        path.join(__dirname, 'snapshot-diff.cjs'),
        BASELINE,
        OUT_SNAPSHOT
    ]);
}

// Local time with an explicit offset, matching the snapshot's Created stamp so that a
// reader comparing the two files does not have to work out that one is UTC and one is
// local. A bare UTC string here previously made the two files look like separate runs.
const now = new Date();
const localOffsetMinutes = -now.getTimezoneOffset();
const offsetSign = localOffsetMinutes >= 0 ? '+' : '-';
const offsetHours = String(Math.floor(Math.abs(localOffsetMinutes) / 60)).padStart(2, '0');
const offsetMinutes = String(Math.abs(localOffsetMinutes) % 60).padStart(2, '0');
const localParts = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString();
const stamp = `${localParts.replace('T', ' ').slice(0, 19)} (local, UTC${offsetSign}${offsetHours}:${offsetMinutes})`;

const header = [
    '# tencent-ai-detect — changes since last reviewed version',
    '',
    `Generated: ${stamp}`,
    '',
    'The companion `tencent-ai-detect-snapshot.txt` is the complete current source.',
    'This file lists only what differs from the version last handed over.',
    ''
].join('\n');

// The diff tool emits its own top-level heading and a line pointing at the
// baseline path; both are redundant here, so they are dropped.
const trimmed = diff
    .replace(/^# Snapshot diff\s*\n/, '')
    .replace(/^- old: .*\n/m, '')
    .replace(/^- new: .*\n/m, '')
    .replace(/^\s*\n/, '');

fs.writeFileSync(OUT_CHANGES, header + '\n' + trimmed);

process.stdout.write([
    `snapshot : ${OUT_SNAPSHOT}`,
    `changes  : ${OUT_CHANGES}`,
    `baseline : ${path.relative(ROOT, BASELINE)} (${acceptBaseline ? 'updating' : 'unchanged'})`
].join('\n') + '\n');

if (acceptBaseline) {
    fs.copyFileSync(OUT_SNAPSHOT, BASELINE);
    process.stdout.write('baseline updated to the current snapshot\n');
}
