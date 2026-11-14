// Pins the relay's address policy, and records why it is what it is.
//
// Measured against the real server on 2026-11-14, with the relay carrying the page's own frames:
//
//   synthetic address  -> {fp} answered {"status":"success","availableUses":5}
//   real address       -> {fp} answered {"status":"failed","msg":"Invalid request"}
//
// So a synthetic address is required for the identity handshake; removing it is strictly worse.
// This test exists because the opposite was assumed once and the "fix" was a regression.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'relay.cjs'), 'utf8');

// Spoofing is the default; RELAY_SPOOF=0 is the diagnostic opt-out.
const spoofLine = source
    .split(/\r?\n/)
    .find(line => line.includes('const spoof ='));

assert.ok(spoofLine, 'the address decision must live in one place');
assert.match(
    spoofLine,
    /process\.env\.RELAY_SPOOF !== '0'/,
    'spoofing must be on by default, with RELAY_SPOOF=0 as the opt-out'
);

// The header is derived from that decision and is empty only when opted out.
const forwardedLine = source
    .split(/\r?\n/)
    .find(line => line.includes('const forwarded ='));

assert.ok(forwardedLine, 'the forwarded header must be computed in one place');
assert.ok(forwardedLine.includes('spoof ?'), 'the header must depend on the decision');
assert.ok(forwardedLine.trim().endsWith(": '';"), 'the header must be empty when opted out');

// Two switches for one decision would let the two drift apart again.
assert.ok(!source.includes('RELAY_NO_SPOOF'), 'the old RELAY_NO_SPOOF flag must not remain');

// The upstream request interpolates the decision, never the raw address.
const requestStart = source.indexOf('GET ${UPSTREAM_PATH}');
const requestEnd = source.indexOf('User-Agent: Mozilla', requestStart);
assert.ok(requestStart > 0 && requestEnd > requestStart, 'the upstream request must be locatable');

const request = source.slice(requestStart, requestEnd);
assert.ok(/^\s*forwarded \+$/m.test(request), 'the request must use the decision value');
assert.ok(!/\$\{ip\}/.test(request), 'the request must not inline the raw address');

console.log('PASS: the relay sends a synthetic address by default, with RELAY_SPOOF=0 as the opt-out');
