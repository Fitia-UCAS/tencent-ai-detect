// Speaks the native messaging protocol to nm-host.cjs exactly like the browser does: a 4-byte
// little-endian length, then UTF-8 JSON.
//
// This test owns the relay lifecycle, so it asserts ownership rather than liveness. An earlier
// version checked only that the host answered "ready" and that something accepted a TCP
// connection on the relay port. Neither proves the relay under test exists:
//
//   - the host sends {type:'ready'} on load, before any relay is started;
//   - any listener satisfies a connect, including a foreign relay the host found and reused
//     (it reports reused:true), which is exactly what happens on a machine that already has this
//     extension loaded in a browser.
//
// Measured: with the extension's own relay occupying 9420, the old test printed relayPortOpen
// true, "OK: host exited", and exited 0 without starting anything. The assertions below are what
// it takes to distinguish that from a real run.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const HOST = path.join(__dirname, '..', '..', 'src', 'host', 'native-host.cjs');
const PORT = 9420;
const SERVICE_MARKER = 'zq-local-relay-v1';

const failures = [];
const ok = message => process.stdout.write(`  ok    ${message}\n`);
const fail = message => {
    failures.push(message);
    process.stdout.write(`  FAIL  ${message}\n`);
};

function frame(value) {
    const json = Buffer.from(JSON.stringify(value), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(json.length, 0);
    return Buffer.concat([head, json]);
}

function isListening(port) {
    return new Promise(resolve => {
        const socket = net.connect(port, '127.0.0.1');
        socket.setTimeout(700);
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('timeout', () => { socket.destroy(); resolve(false); });
        socket.once('error', () => resolve(false));
    });
}

function health(port) {
    return new Promise(resolve => {
        const request = require('node:http').get(
            { host: '127.0.0.1', port, path: '/health', timeout: 1500 },
            response => {
                let body = '';
                response.setEncoding('utf8');
                response.on('data', chunk => { body += chunk; });
                response.on('end', () => {
                    try {
                        resolve(JSON.parse(body));
                    } catch {
                        resolve(null);
                    }
                });
            }
        );
        request.on('timeout', () => { request.destroy(); resolve(null); });
        request.on('error', () => resolve(null));
    });
}

// The listener's parent process. The host spawns the relay as its direct child, so this is what
// ties a listening port to the host this test started rather than to one it borrowed.
function parentPidOf(pid) {
    if (!pid) return null;

    if (process.platform === 'win32') {
        const result = require('node:child_process').spawnSync('powershell', [
            '-NoProfile', '-NonInteractive', '-Command',
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").ParentProcessId`
        ], { encoding: 'utf8' });
        const value = Number(String(result.stdout || '').trim());
        return Number.isInteger(value) && value > 0 ? value : null;
    }

    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        // The command name may contain spaces and parentheses, so the fields after the last ')'
        // are the only stable ones. ppid is the second of those.
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const value = Number(fields[1]);
        return Number.isInteger(value) && value > 0 ? value : null;
    } catch {
        return null;
    }
}

function listenerPid(port) {
    return require('../../tools/find-relay-pid.cjs').relayPidForPort(port);
}

async function waitFor(predicate, attempts, gap) {
    for (let i = 0; i < attempts; i += 1) {
        if (await predicate()) return true;
        await new Promise(resolve => setTimeout(resolve, gap));
    }
    return false;
}

(async () => {
    // The port has to be free before the host starts, or "the relay is up" is a statement about
    // someone else's process. Same precondition the e2e tests apply.
    if (await isListening(PORT)) {
        fail(`a relay is already listening on ${PORT}; this test must own the lifecycle. Stop it first (npm run stop:relay, or disable the extension in the browser that owns it).`);
        process.stdout.write(`\n${failures.length} check(s) failed\n`);
        process.exitCode = 1;
        return;
    }
    ok(`port ${PORT} is free before the test`);

    const child = spawn(process.execPath, [HOST], { stdio: ['pipe', 'pipe', 'pipe'] });

    const received = [];
    let buffer = Buffer.alloc(0);
    child.stdout.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
            const length = buffer.readUInt32LE(0);
            if (buffer.length < 4 + length) return;
            const payload = buffer.slice(4, 4 + length).toString('utf8');
            buffer = buffer.slice(4 + length);
            try {
                received.push(JSON.parse(payload));
            } catch {
                received.push({ parseError: payload.slice(0, 80) });
            }
        }
    });
    child.stderr.on('data', chunk => process.stderr.write('[host] ' + chunk));

    // The host announces itself on load and starts the relay on demand, so the request has to be
    // sent explicitly for the relay assertions to mean anything.
    child.stdin.write(frame({ type: 'ensure' }));

    try {
        const ready = await waitFor(() => received.some(m => m.type === 'ready'), 40, 100);
        ready ? ok('host reported ready') : fail('host never reported ready');

        // ensureRelay is asynchronous. Without this wait the port check below races it.
        const relayed = await waitFor(() => received.some(m => m.type === 'relay'), 100, 100);
        if (!relayed) {
            fail('host never answered the ensure request');
        } else {
            const reply = received.find(m => m.type === 'relay');
            if (reply.ok === true && reply.reused === false) {
                ok('the host started a relay rather than reusing one');
            } else {
                fail(`expected a freshly started relay (ok=true reused=false), got ${JSON.stringify(reply)}`);
            }
        }

        const body = await health(PORT);
        if (body && body.ok === true && body.service === SERVICE_MARKER) {
            ok(`/health answered with the relay service marker`);
        } else {
            fail(`/health did not identify this project's relay: ${JSON.stringify(body)}`);
        }

        const pid = listenerPid(PORT);
        if (!pid) {
            fail('could not attribute the listening port to a process');
        } else {
            const parent = parentPidOf(pid);
            if (parent === child.pid) {
                ok(`listener ${pid} is a child of this test's host (${child.pid})`);
            } else {
                fail(`listener ${pid} is not a child of this test's host ${child.pid} (parent ${parent})`);
            }
        }

        // Closing stdin is what the browser does on shutdown; the host terminates the relay it
        // started. That the port goes quiet is the part the old version never checked.
        child.stdin.end();

        const hostExited = await waitFor(() => child.exitCode !== null, 60, 100);
        hostExited ? ok('host exited after stdin closed') : fail('host still running after stdin closed');

        const freed = await waitFor(async () => !(await isListening(PORT)), 60, 100);
        freed
            ? ok(`port ${PORT} was released, so the relay died with its host`)
            : fail(`port ${PORT} is still listening; the relay outlived the host that started it`);
    } finally {
        if (child.exitCode === null) child.kill();
    }

    if (failures.length) {
        process.stdout.write(`\n${failures.length} check(s) failed\n`);
        process.exitCode = 1;
    } else {
        process.stdout.write('\nall checks passed\n');
    }
})().catch(error => {
    process.stderr.write('nm-protocol test errored: ' + (error && error.message ? error.message : error) + '\n');
    process.exitCode = 1;
});
