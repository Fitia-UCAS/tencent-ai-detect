// Guards the indentation width across the repository.
//
// The tree carried both two-space and four-space files because nothing checked. A test that only
// reads the files cannot tell the styles apart without duplicating the scanner, so this runs the
// same tool that rewrites them, in report mode, and fails when it would rewrite anything.
//
// Report mode touches no files, so a failure here is safe to read: the listed files are the ones
// that need `npm run style`.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..', '..');
const tool = path.join(root, 'tools', 'normalize-style.cjs');

const result = spawnSync(process.execPath, [tool], {
    encoding: 'utf8',
    timeout: 60000,
    cwd: root
});

assert.equal(result.error, undefined, `style check could not run: ${result.error?.message}`);

const output = (result.stdout || '') + (result.stderr || '');

// The tool exits nonzero only when it restored a file that stopped parsing. That is a defect in
// the tool or in the file, not a style question, so it must not be reported as one.
if (result.status !== 0) {
    console.error(output);
    throw new Error('the style tool failed while inspecting the tree');
}

const summary = output.match(/(\d+) file\(s\) with two-space indentation/);
assert.ok(summary, 'the style tool must report a count');

const pending = Number(summary[1]);
const offenders = output
    .split('\n')
    .filter(line => line.startsWith('would rewrite'))
    .map(line => line.replace('would rewrite  ', '').trim());

if (pending > 0) {
    for (const file of offenders) console.error('  ' + file);
}

assert.equal(pending, 0, 'indentation is not uniform; run npm run style to rewrite the files listed above');

console.log('PASS: every source file uses the same indentation width');
