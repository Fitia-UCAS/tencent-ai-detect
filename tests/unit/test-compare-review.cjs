const assert = require('node:assert/strict');
const { parsePatch, applyHunks } = require('../../tools/compare-review.cjs');

const checks = [];
function check(name, run) {
    checks.push([name, run]);
}

const validPatch = [
    'diff --git a/sample.txt b/sample.txt',
    'index 1111111..2222222 100644',
    '--- a/sample.txt',
    '+++ b/sample.txt',
    '@@ -1,2 +1,3 @@',
    ' alpha',
    '-beta',
    '+beta updated',
    '+gamma',
    ''
].join('\n');

check('parsePatch retains old and new hunk counts', () => {
    const [file] = parsePatch(validPatch);
    assert.equal(file.path, 'sample.txt');
    assert.equal(file.hunks[0].oldCount, 2);
    assert.equal(file.hunks[0].newCount, 3);
});

check('applyHunks reconstructs a valid replacement hunk', () => {
    const [file] = parsePatch(validPatch);
    const result = applyHunks(['alpha', 'beta', 'omega'], file.hunks);

    assert.deepEqual(result.lines, ['alpha', 'beta updated', 'gamma', 'omega']);
    assert.equal(result.drift, 0);
    assert.deepEqual(result.errors, []);
});

check('applyHunks rejects a body whose old-line count differs from the header', () => {
    const [file] = parsePatch(validPatch.replace('@@ -1,2 +1,3 @@', '@@ -1,3 +1,3 @@'));
    const result = applyHunks(['alpha', 'beta', 'omega'], file.hunks);

    assert.ok(result.errors.some(error => error.includes('declares 3/3 lines, body contains 2/3')));
});

check('applyHunks rejects a body whose new-line count differs from the header', () => {
    const [file] = parsePatch(validPatch.replace('@@ -1,2 +1,3 @@', '@@ -1,2 +1,4 @@'));
    const result = applyHunks(['alpha', 'beta', 'omega'], file.hunks);

    assert.ok(result.errors.some(error => error.includes('declares 2/4 lines, body contains 2/3')));
});

check('applyHunks reports context drift separately from malformed hunk structure', () => {
    const [file] = parsePatch(validPatch);
    const result = applyHunks(['different', 'beta', 'omega'], file.hunks);

    assert.equal(result.drift, 1);
    assert.deepEqual(result.errors, []);
});

check('zero-length old range inserts after oldStart lines', () => {
    const patch = [
        'diff --git a/sample.txt b/sample.txt',
        '--- a/sample.txt',
        '+++ b/sample.txt',
        '@@ -1,0 +2 @@',
        '+inserted',
        ''
    ].join('\n');
    const [file] = parsePatch(patch);
    const result = applyHunks(['a', 'b'], file.hunks);

    assert.deepEqual(result.lines, ['a', 'inserted', 'b']);
    assert.deepEqual(result.errors, []);
});

check('applyHunks reports overlapping or out-of-order hunks', () => {
    const patch = [
        'diff --git a/sample.txt b/sample.txt',
        '--- a/sample.txt',
        '+++ b/sample.txt',
        '@@ -1,2 +1,2 @@',
        ' a',
        ' b',
        '@@ -2 +2 @@',
        '-b',
        '+B',
        ''
    ].join('\n');
    const [file] = parsePatch(patch);
    const result = applyHunks(['a', 'b', 'c'], file.hunks);

    assert.ok(result.errors.some(error => error.includes('overlap or are out of order')));
});

check('applyHunks reports ranges extending beyond the base', () => {
    const patch = [
        'diff --git a/sample.txt b/sample.txt',
        '--- a/sample.txt',
        '+++ b/sample.txt',
        '@@ -4 +4 @@',
        '-missing',
        '+present',
        ''
    ].join('\n');
    const [file] = parsePatch(patch);
    const result = applyHunks(['a', 'b'], file.hunks);

    assert.ok(result.errors.some(error => error.includes('starts beyond end of base')));
    assert.ok(result.errors.some(error => error.includes('deletion extends beyond end of base')));
});

(async () => {
    let failures = 0;

    for (const [name, run] of checks) {
        try {
            await run();
            process.stdout.write('  ok    ' + name + '\n');
        } catch (error) {
            failures += 1;
            process.stderr.write('  FAIL  ' + name + ': ' + error.message + '\n');
        }
    }

    process.stdout.write(`\n${failures ? 'FAIL' : 'PASS'}: ${checks.length - failures}/${checks.length} compare-review checks\n`);
    if (failures) process.exitCode = 1;
})();
