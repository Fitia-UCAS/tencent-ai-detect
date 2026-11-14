const assert = require('node:assert/strict');
const { parsePatch, applyHunks, openIssueLines, runProbe, probeFileSets } = require('../../tools/compare-review.cjs');

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

// format-patch output carries a signature and a diffstat after the last hunk of a commit. Those
// lines start with "-- " and "---", which look exactly like deletions, so a parser that keeps
// reading past the declared counts absorbs them and then rejects its own hunk. Reading a
// multi-commit patch is the -p/--stdout form, so this is the shape that matters in practice.
check('parsePatch stops a hunk once its declared counts are satisfied', () => {
    const multiCommit = [
        'diff --git a/sample.txt b/sample.txt',
        '--- a/sample.txt',
        '+++ b/sample.txt',
        '@@ -1,2 +1,2 @@',
        ' alpha',
        '-beta',
        '+beta updated',
        '-- ',
        '2.43.0',
        '',
        'diff --git a/other.txt b/other.txt',
        '--- a/other.txt',
        '+++ b/other.txt',
        '@@ -1,1 +1,1 @@',
        '-old',
        '+new',
        ''
    ].join('\n');

    const files = parsePatch(multiCommit);
    assert.equal(files.length, 2);

    const [first, second] = files;
    assert.equal(first.hunks.length, 1);
    assert.deepEqual(first.hunks[0].lines, [' alpha', '-beta', '+beta updated']);

    const result = applyHunks(['alpha', 'beta'], first.hunks);
    assert.deepEqual(result.errors, []);
    assert.equal(result.drift, 0);
    assert.deepEqual(result.lines, ['alpha', 'beta updated']);

    assert.equal(second.path, 'other.txt');
    assert.deepEqual(second.hunks[0].lines, ['-old', '+new']);
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

check('unresolved section only lists proposals that are actually open', () => {
    const entries = [
        { id: 'P1-7', file: 'src/shim/index.js', topic: 'fallback fixed', verdict: 'extended' },
        { id: 'P1-9', file: 'src/background/identity.js', topic: 'single-tab limitation', verdict: 'open' },
        { id: 'P1-11', file: 'src/content/auto.js', topic: 'state label fixed', verdict: 'adopted' }
    ];
    const lines = openIssueLines(entries).join('\n');
    assert.match(lines, /1 item\(s\) are agreed but not done/);
    assert.match(lines, /P1-9/);
    assert.doesNotMatch(lines, /P1-7/);
    assert.doesNotMatch(lines, /P1-11/);
    assert.doesNotMatch(lines, /fallback fixed/);
});

check('unresolved section reports none when everything is resolved', () => {
    assert.deepEqual(openIssueLines([
        { id: 'P1-7', file: 'src/shim/index.js', topic: 'fixed', verdict: 'extended' }
    ]), ['Nothing is marked agreed-but-not-done.']);
});

check('unresolved section lists all open issues with identifiers', () => {
    const lines = openIssueLines([
        { id: 'P1', file: 'a.js', topic: 'first', verdict: 'open' },
        { id: 'P2', file: 'b.js', topic: 'second', verdict: 'open' }
    ]).join('\n');
    assert.match(lines, /2 item\(s\) are agreed but not done/);
    assert.match(lines, /P1 `a\.js`: first/);
    assert.match(lines, /P2 `b\.js`: second/);
});

check('file probes do not borrow files from the working tree when evaluating the patch', () => {
    const proposals = [{ id: 'P', file: 'a.js', probe: { files: ['new.js'] } }];
    const sets = probeFileSets(proposals, [], () => false, file => file === 'new.js');
    assert.match(runProbe(proposals[0], null, sets.theirs), /missing file\(s\): new\.js/);
    assert.equal(runProbe(proposals[0], null, sets.ours), null);
});

check('file probes credit files already present at the base', () => {
    const proposals = [{ id: 'P', file: 'a.js', probe: { files: ['old.js'] } }];
    const sets = probeFileSets(proposals, [], file => file === 'old.js', file => file === 'old.js');
    assert.equal(runProbe(proposals[0], null, sets.theirs), null);
    assert.equal(runProbe(proposals[0], null, sets.ours), null);
});

check('file probes credit new patch files but not deleted files', () => {
    const proposals = [{ id: 'P', file: 'a.js', probe: { files: ['added.js', 'deleted.js'] } }];
    const patchFiles = [{ path: 'added.js', isNew: true }, { path: 'deleted.js', deleted: true }];
    const sets = probeFileSets(proposals, patchFiles, () => true, () => false);
    assert.equal(sets.theirs.has('added.js'), true);
    assert.equal(sets.theirs.has('deleted.js'), false);
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
