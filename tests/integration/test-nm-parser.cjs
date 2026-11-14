// Exercises the Native Messaging control parser without sending 'ensure' or
// connecting to any external service. Uses the actual host stdio framing.
const { spawn } = require('node:child_process');
const path = require('node:path');

const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'src', 'host', 'native-host.cjs')], {
    stdio: ['pipe', 'pipe', 'pipe']
});
const replies = [];
let received = Buffer.alloc(0);
let finished = false;

function pack(value) {
    const text = Buffer.from(JSON.stringify(value), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(text.length);
    return Buffer.concat([header, text]);
}

function finish(error) {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    child.stdin.end();
    if (error) {
        console.error('FAIL:', error);
        process.exitCode = 1;
    } else {
        console.log('PASS: native host parser survived invalid JSON shapes and two pings');
    }
}

child.stdout.on('data', chunk => {
    received = Buffer.concat([received, chunk]);
    while (received.length >= 4) {
        const size = received.readUInt32LE(0);
        if (received.length < 4 + size) break;
        const response = JSON.parse(received.subarray(4, 4 + size).toString('utf8'));
        replies.push(response);
        received = received.subarray(4 + size);
    }

    if (replies.length >= 6) {
        const types = replies.map(r => r.type);
        const ready = types.filter(t => t === 'ready').length;
        const pong = types.filter(t => t === 'pong').length;
        const errors = types.filter(t => t === 'error').length;
        finish(ready === 1 && pong === 2 && errors === 3
            ? null : `unexpected replies: ${JSON.stringify(replies)}`);
    }
});

child.on('error', error => finish(error.message));
child.on('exit', (code, signal) => {
    if (!finished) finish(`host exited early: code=${code} signal=${signal}`);
});

const timeout = setTimeout(() => finish('no complete reply sequence'), 3500);

// Deliberately split one native frame mid-header; deliver the others together.
const first = pack({ type: 'ping' });
child.stdin.write(first.subarray(0, 2));
setTimeout(() => {
    child.stdin.write(Buffer.concat([
        first.subarray(2), pack(null), pack([]),
        pack({ foo: 1 }), pack({ type: 'ping' })
    ]));
}, 10);
