const assert = require('node:assert/strict');
const { resolveIdleTimeout } = require('../../src/relay/config.cjs');

assert.equal(resolveIdleTimeout({}), 120000);
assert.equal(resolveIdleTimeout({ RELAY_IDLE_MS: '' }), 120000);
assert.equal(resolveIdleTimeout({ RELAY_IDLE_MS: '0' }), 0);
assert.equal(resolveIdleTimeout({ RELAY_IDLE_MS: '250' }), 250);
assert.throws(() => resolveIdleTimeout({ RELAY_IDLE_MS: '-1' }), /non-negative/);
assert.throws(() => resolveIdleTimeout({ RELAY_IDLE_MS: 'not-a-number' }), /non-negative/);

process.stdout.write('PASS: 6/6 relay idle-timeout configuration checks\n');
