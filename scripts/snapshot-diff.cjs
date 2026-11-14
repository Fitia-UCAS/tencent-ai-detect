#!/usr/bin/env node

// Emits a per-file Markdown diff between two project snapshots produced by
// project_snapshot.py.
//
// A raw unified diff of the whole snapshot is unreadable: the snapshot is one
// concatenated file, so every shifted line looks changed. This compares the
// extracted files instead and prints only the files whose content differs.
//
// Usage: node scripts/snapshot-diff.cjs <old.txt> <new.txt> [--full]

const fs = require('node:fs');

const END_MARKER_RE = /^<<<END FILE/;
const HEADER_RE = /^(.+) 的内容 \[(.*)\]:$/;

// Parses a snapshot into { path -> content }.
function parse(file) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const files = new Map();

    let current = null;
    let buffer = [];

    for (const line of lines) {
        const header = line.match(HEADER_RE);

        if (header) {
            current = header[1];
            buffer = [];
            continue;
        }

        if (END_MARKER_RE.test(line)) {
            if (current !== null) {
                files.set(current, buffer.join('\n'));
                current = null;
                buffer = [];
            }
            continue;
        }

        if (current !== null) buffer.push(line);
    }

    return files;
}

// Minimal line diff: longest common subsequence, enough for readable summaries.
function diffLines(a, b) {
    const left = a.split('\n');
    const right = b.split('\n');
    const n = left.length;
    const m = right.length;

    // Guard against quadratic blowup on very large files.
    if (n * m > 4_000_000) {
        return { added: m, removed: n, hunks: [] };
    }

    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));

    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = left[i] === right[j]
                ? dp[i + 1][j + 1] + 1
                : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    const hunks = [];
    let added = 0;
    let removed = 0;
    let i = 0;
    let j = 0;

    while (i < n && j < m) {
        if (left[i] === right[j]) {
            i++;
            j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            hunks.push('- ' + left[i]);
            removed++;
            i++;
        } else {
            hunks.push('+ ' + right[j]);
            added++;
            j++;
        }
    }

    while (i < n) { hunks.push('- ' + left[i++]); removed++; }
    while (j < m) { hunks.push('+ ' + right[j++]); added++; }

    return { added, removed, hunks };
}

const [oldFile, newFile] = process.argv.slice(2);
const full = process.argv.includes('--full');

if (!oldFile || !newFile) {
    process.stderr.write('usage: snapshot-diff.cjs <old.txt> <new.txt> [--full]\n');
    process.exit(2);
}

const before = parse(oldFile);
const after = parse(newFile);

const added = [...after.keys()].filter(k => !before.has(k));
const removed = [...before.keys()].filter(k => !after.has(k));
const changed = [...after.keys()].filter(k => before.has(k) && before.get(k) !== after.get(k));

const out = [];

out.push(`# Snapshot diff`);
out.push('');
out.push(`- old: \`${oldFile}\` (${before.size} files)`);
out.push(`- new: \`${newFile}\` (${after.size} files)`);
out.push('');

out.push(`## Files added (${added.length})`);
added.sort().forEach(f => out.push(`- ${f}`));
out.push('');

out.push(`## Files removed (${removed.length})`);
removed.sort().forEach(f => out.push(`- ${f}`));
out.push('');

out.push(`## Files changed (${changed.length})`);
out.push('');

for (const file of changed.sort()) {
    const d = diffLines(before.get(file), after.get(file));
    out.push(`### ${file}  (+${d.added} / -${d.removed})`);
    out.push('');
    out.push('```diff');

    // Cap output per file unless --full is passed, so the summary stays readable.
    const limit = full ? d.hunks.length : Math.min(d.hunks.length, 120);
    out.push(...d.hunks.slice(0, limit));

    if (limit < d.hunks.length) {
        out.push(`... ${d.hunks.length - limit} more line(s), rerun with --full`);
    }

    out.push('```');
    out.push('');
}

process.stdout.write(out.join('\n'));
