// Speaks the native messaging protocol to nm-host.cjs exactly like the browser does: a 4-byte
// little-endian length, then UTF-8 JSON.
//
// This test does NOT load the extension and does not need the product's relay port. The host reads
// RELAY_PORT from its environment and passes the same value to the relay it spawns, so the test
// asks the OS for a free port and hands it over. That keeps the test runnable while a browser has
// this extension loaded and holding 9420 - which is the normal state of a development machine.
//
// Two earlier versions were wrong in different ways, both recorded here because both looked green:
//
//   1. It required 9420 to be free, so it failed on any machine where the extension was in use.
//   2. It asserted only that the host answered {type:'ready'} and that something accepted a TCP
//      connection. Neither is evidence of a relay: the host sends ready on load before starting
//      anything, and any listener satisfies a connect - including a foreign relay it reused,
//      which it reports as reused:true. Measured: with the extension's relay on 9420 the old test
//      printed relayPortOpen true, "OK: host exited" and exited 0 without starting anything.
//
// So the assertions below are about ownership: a relay this test caused to exist, on a port this
// test chose, in a process descended from the host this test spawned, gone when the host exits.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const path = require('node:path');

const HOST = path.join(__dirname, '..', '..', 'src', 'host', 'native-host.cjs');
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

// Holding the port open until the host is launched is the point: asking for port 0, reading the
// assigned number and closing immediately leaves a gap another process could take. The host is
// started while the socket is still bound, then it is released just before the host builds.
function reservePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                port,
                release: () => new Promise(done => server.close(done))
            });
        });
    });
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
        const request = http.get(
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
// ties the listening port to the host this test started.
function parentPidOf(pid) {
    if (!pid) return null;

    if (process.platform === 'win32') {
        const result = spawnSync('powershell', [
            '-NoProfile', '-NonInteractive', '-Command',
            `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").ParentProcessId`
        ], { encoding: 'utf8', windowsHide: true, timeout: 7000 });
        const value = Number(String(result.stdout || '').trim());
        return Number.isInteger(value) && value > 0 ? value : null;
    }

    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        // A command name may contain spaces and parentheses, so only the fields after the last ')'
        // are stable. ppid is the second of those.
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const value = Number(fields[1]);
        return Number.isInteger(value) && value > 0 ? value : null;
    } catch {
        return null;
    }
}

function listenerPid(port) {
    const { relayPidForPort } = require('../../tools/find-relay-pid.cjs');
    return relayPidForPort(port);
}

async function waitFor(predicate, attempts, gap) {
    for (let i = 0; i < attempts; i += 1) {
        if (await predicate()) return true;
        await new Promise(resolve => setTimeout(resolve, gap));
    }
    return false;
}

(async () => {
    const reserved = await reservePort();
    const PORT = reserved.port;
    ok(`reserved a free port for this run (${PORT}), so 9420 is irrelevant here`);

    const child = spawn(process.execPath, [HOST], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, { RELAY_PORT: String(PORT) })
    });

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

    try {
        const ready = await waitFor(() => received.some(m => m.type === 'ready'), 40, 100);
        if (!ready) {
            fail('host never reported ready');
        } else {
            const hello = received.find(m => m.type === 'ready');
            // Catches a host that ignores RELAY_PORT and would silently bind the product port.
            hello.port === PORT
                ? ok(`host reported ready on the requested port ${PORT}`)
                : fail(`host reported port ${hello.port}, expected ${PORT} - it ignored RELAY_PORT`);
        }

        await reserved.release();

        // The relay starts on demand, so it has to be asked for. Without this the port assertions
        // below would only be describing whatever happened to be there.
        child.stdin.write(frame({ type: 'ensure' }));

        const relayed = await waitFor(() => received.some(m => m.type === 'relay'), 100, 100);
        if (!relayed) {
            fail('host never answered the ensure request');
        } else {
            const reply = received.find(m => m.type === 'relay');
            reply.ok === true && reply.reused === false
                ? ok('the host started a relay rather than reusing one')
                : fail(`expected a freshly started relay (ok=true reused=false), got ${JSON.stringify(reply)}`);
        }

        const body = await health(PORT);
        body && body.ok === true && body.service === SERVICE_MARKER
            ? ok('/health answered with the relay service marker')
            : fail(`/health did not identify this project's relay: ${JSON.stringify(body)}`);

        const pid = listenerPid(PORT);
        if (!pid) {
            fail('could not attribute the listening port to a process');
        } else if (parentPidOf(pid) === child.pid) {
            ok(`listener ${pid} is a child of this test's host (${child.pid})`);
        } else {
            fail(`listener ${pid} is not a child of this test's host ${child.pid} (parent ${parentPidOf(pid)})`);
        }

        // Closing stdin is what the browser does on shutdown. That the port goes quiet is the
        // assertion the old version never made: it claimed to start a relay and never checked
        // that the process had stopped.
        child.stdin.end();

        await waitFor(() => child.exitCode !== null, 60, 100)
            ? ok('host exited after stdin closed')
            : fail('host still running after stdin closed');

        await waitFor(async () => !(await isListening(PORT)), 60, 100)
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
