// Negative control: an unexpected rejected Promise MUST make the content-context suite fail.
// No product code is changed. The injected rejection runs once the suite has registered
// its unhandledRejection handler; the child must return nonzero despite passing other checks.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const target = path.join(__dirname, 'test-content-context.cjs');
const sentinel = 'AUDIT_UNHANDLED_REJECTION_SENTINEL';
const injectedScript = `
    process.nextTick(() => Promise.reject(new Error(${JSON.stringify(sentinel)})));
    require(${JSON.stringify(target)});
`;

const result = spawnSync(process.execPath, ['-e', injectedScript], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, NODE_OPTIONS: '--unhandled-rejections=warn' }
});

assert.equal(result.error, undefined, `test runner errored: ${result.error?.message}`);
const output = `${result.stdout || ''}\n${result.stderr || ''}`;
assert.match(output, /FAIL\s+unhandled rejection:/, 'injected rejection must be detected');
assert.ok(output.includes(sentinel), 'the expected negative control must have been injected');
assert.notEqual(result.status, 0, 'a printed FAIL must never exit with code zero');
assert.doesNotMatch(output, /all checks passed/, 'the summary must not claim all checks passed');
console.log('PASS: unexpected rejection makes content-context exit nonzero');

// A suite that reports PASS but leaves background timers running can hang a test job.
// The quota parser checks must finish promptly, not just emit their PASS summary.
const quota = spawnSync(process.execPath, [path.join(__dirname, 'test-quota-wording.cjs')], {
    encoding: 'utf8',
    timeout: 4000,
    env: { ...process.env, NODE_OPTIONS: '--unhandled-rejections=strict' }
});
assert.equal(quota.error, undefined, `quota wording test hung: ${quota.error?.message}`);
assert.equal(quota.status, 0, `quota wording test failed: ${quota.stderr || quota.stdout}`);
assert.match(quota.stdout, /PASS: 14\/14 quota wording checks/);
console.log('PASS: quota wording checks exit after reporting success');

// The runner must not count itself among the tests it did not run. Its own source contains the
// browser marker literals, so reading itself back classified `test:all` as a browser test and
// the "not run" tally was one too high. Both the run list and that tally are built from the same
// self-filtered selector, so listing is enough to cover it.
//
// The marker strings are described rather than written here: this file is classified by the same
// source scan, so quoting them would file this suite under the browser tier.
const runner = path.join(__dirname, '..', '..', 'tools', 'regression.cjs');
// This suite itself runs as a regression child, and the runner refuses to re-enter from one.
const env = { ...process.env };
delete env.ZQ_REGRESSION_CHILD;
const listed = spawnSync(process.execPath, [runner, '--list'], { encoding: 'utf8', timeout: 20000, env });
assert.equal(listed.status, 0, `regression --list failed: ${listed.stderr}`);
assert.doesNotMatch(listed.stdout, /test:all/, 'the runner must not list itself as a test');
console.log('PASS: the runner does not count itself as a skipped browser test');
