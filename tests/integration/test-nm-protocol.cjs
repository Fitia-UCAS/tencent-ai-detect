// Speaks the native messaging protocol to nm-host.cjs exactly like the browser
// does: 4-byte little-endian length, then UTF-8 JSON. Verifies that the host
// starts the relay and answers.
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const HOST = path.join(__dirname, '..', '..', 'src', 'host', 'native-host.cjs');
const PORT = 9420;

function frame(obj) {
    const json = Buffer.from(JSON.stringify(obj), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(json.length, 0);
    return Buffer.concat([head, json]);
}

const child = spawn(process.execPath, [HOST], { stdio: ['pipe', 'pipe', 'pipe'] });

const received = [];
let buffer = Buffer.alloc(0);

child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 4) {
        const len = buffer.readUInt32LE(0);
        if (buffer.length < 4 + len) return;

        const payload = buffer.slice(4, 4 + len).toString('utf8');
        buffer = buffer.slice(4 + len);

        try {
            received.push(JSON.parse(payload));
        } catch (e) {
            received.push({ parseError: payload.slice(0, 80) });
        }
    }
});

child.stderr.on('data', chunk => process.stderr.write('[host] ' + chunk));

child.stdin.write(frame({ type: 'ensure' }));

setTimeout(async () => {
    // Connect the way the page would, to prove the relay is actually serving.
    const ok = await new Promise(resolve => {
        const s = net.connect(PORT, '127.0.0.1');
        s.setTimeout(1500);
        s.once('connect', () => { s.destroy(); resolve(true); });
        s.once('timeout', () => { s.destroy(); resolve(false); });
        s.once('error', () => resolve(false));
    });

    console.log(JSON.stringify({ received, relayPortOpen: ok }, null, 2));

    // Closing stdin is what the browser does on shutdown; the host must exit.
    child.stdin.end();

    setTimeout(() => {
        const alive = child.exitCode === null;
        console.log(alive ? 'FAIL: host still running after stdin closed' : 'OK: host exited');
        process.exitCode = ok && !alive && received.some(m => m.type === 'ready') ? 0 : 1;
        process.exit();
    }, 1500);
}, 5000);
