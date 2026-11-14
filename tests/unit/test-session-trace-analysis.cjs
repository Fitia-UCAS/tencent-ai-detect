const assert = require('node:assert/strict');
const { classifyPayload, analyzeVerifiedFlow } = require('../../tools/session-trace-analysis.cjs');

const checks = [
    ['classifies only code=1 and evil_level=0 as captcha success', () => {
        assert.equal(classifyPayload('{"code":"1","evil_level":"0"}').kind, 'captcha-success');
        assert.notEqual(classifyPayload('{"code":"1","evil_level":"1"}').kind, 'captcha-success');
    }],
    ['recognizes a verified text frame on the same socket in order', () => {
        const result = analyzeVerifiedFlow([
            { timeMs: 1, requestId: 'a', label: 'ws#1', direction: 'send', kind: 'ticket' },
            { timeMs: 2, requestId: 'a', label: 'ws#1', direction: 'recv', kind: 'captcha-success' },
            { timeMs: 3, requestId: 'a', label: 'ws#1', direction: 'send', kind: 'text' }
        ]);
        assert.equal(result.status, 'verified-text-same-socket');
    }],
    ['does not confuse ticket/text on one socket with success on another', () => {
        const result = analyzeVerifiedFlow([
            { timeMs: 1, requestId: 'a', label: 'ws#1', direction: 'send', kind: 'ticket' },
            { timeMs: 2, requestId: 'b', label: 'ws#2', direction: 'recv', kind: 'captcha-success' },
            { timeMs: 3, requestId: 'a', label: 'ws#1', direction: 'send', kind: 'text' }
        ]);
        assert.equal(result.status, 'captcha-success-on-different-socket');
    }],
    ['does not treat text sent before verification as a valid flow', () => {
        const result = analyzeVerifiedFlow([
            { timeMs: 1, requestId: 'a', label: 'ws#1', direction: 'send', kind: 'ticket' },
            { timeMs: 2, requestId: 'a', label: 'ws#1', direction: 'send', kind: 'text' },
            { timeMs: 3, requestId: 'a', label: 'ws#1', direction: 'recv', kind: 'captcha-success' }
        ]);
        assert.equal(result.status, 'text-before-captcha-success');
    }],
    ['does not claim success when no text follows verification', () => {
        const result = analyzeVerifiedFlow([
            { timeMs: 1, requestId: 'a', label: 'ws#1', direction: 'send', kind: 'ticket' },
            { timeMs: 2, requestId: 'a', label: 'ws#1', direction: 'recv', kind: 'captcha-success' }
        ]);
        assert.equal(result.status, 'no-text-after-success');
    }]
];

let failures = 0;
for (const [name, run] of checks) {
    try { run(); process.stdout.write(`  ok    ${name}\n`); }
    catch (error) { failures++; process.stdout.write(`  FAIL  ${name}: ${error.message}\n`); }
}
if (failures) process.exitCode = 1;
else process.stdout.write('\nPASS: 5/5 session trace analysis checks\n');
