#!/usr/bin/env node

// Normalises indentation across the repository to one width.
//
// The repository accumulated two indentation styles: src/ and most of tools/ use four spaces,
// while a long tail of tests, diagnostics and scripts use two. Nothing enforced either, so a file
// picked up whichever style it was born with, and new code copied its neighbour.
//
// This is not a formatter. It rewrites leading whitespace only, and it refuses to touch a line
// whose indentation sits inside a template literal or a block comment - those bytes are content,
// not layout. A blind `s/^  /    /` corrupts every multi-line template it meets, which in this
// repository is twelve of them.
//
//   node tools/normalize-style.cjs            report only
//   node tools/normalize-style.cjs --write    rewrite files
//
// Every rewritten file is syntax-checked afterwards; a file that stops parsing is restored and
// reported instead of left broken on disk.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WRITE = process.argv.includes('--write');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.baseline']);

function collect(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collect(full, out);
        else if (/\.(cjs|js)$/.test(entry.name)) out.push(full);
    }
    return out;
}

// Walks the source once and records, for each line, whether the line *begins* inside a literal.
// Only the leading whitespace of a line that begins in real code may be rewritten.
//
// Regex literals have to be recognised, and they cannot be: `/` divides and `/` opens a pattern
// depending on the previous token. Skipping this case is not a small miss - a pattern like
// /<script[^>]*\bsrc="([^"]+)"/g contains quote characters, so treating it as code puts the
// scanner into a string state and every line after it is misread as content. That produced
// half-reindented files: some lines four spaces, some two.
function lineStates(source) {
    const states = [];
    let state = 'code';
    let atLineStart = true;
    // The last meaningful token before the current character, used to tell a regex from division.
    let lastSignificant = '';

    for (let i = 0; i < source.length; i += 1) {
        const c = source[i];
        const next = source[i + 1];

        if (atLineStart) {
            states.push(state);
            atLineStart = false;
        }

        if (state === 'code') {
            if (c === '/' && next === '/') { state = 'line'; i += 1; continue; }
            if (c === '/' && next === '*') { state = 'block'; i += 1; continue; }

            if (c === '/') {
                // A pattern may only start where an operand is expected. After an identifier,
                // a literal, `)` or `]`, the slash is division.
                const operand = /[)\]}A-Za-z0-9_$'"`]/.test(lastSignificant);
                if (!operand) { state = 'regex'; lastSignificant = '/'; continue; }
            }

            if (c === "'") { state = 'single'; lastSignificant = "'"; continue; }
            if (c === '"') { state = 'double'; lastSignificant = '"'; continue; }
            if (c === '`') { state = 'template'; lastSignificant = '`'; continue; }
            if (c === '\n') { atLineStart = true; continue; }
            if (!/\s/.test(c)) lastSignificant = c;
            continue;
        }

        if (state === 'line') {
            if (c === '\n') { state = 'code'; atLineStart = true; }
            continue;
        }

        if (state === 'block') {
            if (c === '*' && next === '/') { state = 'code'; i += 1; continue; }
            if (c === '\n') atLineStart = true;
            continue;
        }

        if (state === 'regex') {
            if (c === '\\') { i += 1; continue; }
            if (c === '\n') { state = 'code'; atLineStart = true; continue; }
            if (c === '[') { state = 'regex-class'; continue; }
            if (c === '/') { state = 'code'; lastSignificant = '/'; continue; }
            continue;
        }

        // A character class inside a pattern: `]` does not end the pattern, and a `/` in here is
        // part of the class rather than the closing delimiter.
        if (state === 'regex-class') {
            if (c === '\\') { i += 1; continue; }
            if (c === ']') { state = 'regex'; continue; }
            continue;
        }

        // single / double / template
        if (c === '\\') { i += 1; continue; }
        if ((state === 'single' && c === "'") || (state === 'double' && c === '"')
            || (state === 'template' && c === '`')) {
            state = 'code';
            lastSignificant = c;
            continue;
        }
        if (c === '\n') atLineStart = true;
    }

    // A file whose last line has no trailing newline still needs a state entry.
    if (states.length < source.split('\n').length) {
        states.push(state);
    }
    return states;
}

function leadingWidth(line) {
    const match = line.match(/^[ \t]*/);
    if (!match) return 0;
    // A tab counts as one character here; none of the files use them, and mixing them in would
    // make the conversion ambiguous rather than merely inconsistent.
    return match[0].length;
}

// Two-space indentation doubles to four-space: each level goes from two to four columns, and
// continuation lines keep their relative offset. Files already on four spaces are left alone.
function indentationWidth(lines, states) {
    let twos = 0;
    let fours = 0;

    lines.forEach((line, index) => {
        if (!line.trim() || states[index] !== 'code') return;
        const width = leadingWidth(line);
        if (width === 0) return;
        if (width % 4 === 2) twos += 1;
        if (width % 4 === 0) fours += 1;
    });

    return twos > fours * 0.15 ? 2 : 4;
}

function convert(file) {
    const original = fs.readFileSync(file, 'utf8');
    const lines = original.split('\n');
    const states = lineStates(original);

    if (indentationWidth(lines, states) !== 2) return null;

    const rewritten = lines.map((line, index) => {
        // Inside a template or block comment the leading whitespace is content.
        if (states[index] !== 'code') return line;
        if (!line.trim()) return '';
        const width = leadingWidth(line);
        if (width === 0) return line;
        return ' '.repeat(width * 2) + line.slice(width).replace(/[ \t]+$/, '');
    }).join('\n');

    if (rewritten === original) return null;

    if (!WRITE) return { file, before: original, after: rewritten, written: false };

    // Syntax-check before keeping the result. A file that stops parsing is restored.
    const backup = original;
    fs.writeFileSync(file, rewritten);
    try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'ignore' });
    } catch (error) {
        fs.writeFileSync(file, backup);
        throw new Error('stops parsing after reindent, restored: ' + path.relative(ROOT, file));
    }

    return { file, before: original, after: rewritten, written: true };
}

const files = collect(ROOT).sort();
const changed = [];
const failures = [];

for (const file of files) {
    try {
        const result = convert(file);
        if (result) changed.push(result);
    } catch (error) {
        failures.push(error.message);
    }
}

for (const item of changed) {
    process.stdout.write((item.written ? 'rewrote  ' : 'would rew') + 'rite  '
        + path.relative(ROOT, item.file).replace(/\\/g, '/') + '\n');
}

process.stdout.write('\n' + changed.length + ' file(s) with two-space indentation'
    + (WRITE ? ', rewritten' : ' (pass --write to rewrite)') + '\n');

if (failures.length) {
    for (const failure of failures) process.stderr.write('FAILED  ' + failure + '\n');
    process.exitCode = 1;
}
