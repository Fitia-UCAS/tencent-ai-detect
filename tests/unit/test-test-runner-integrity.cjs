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
