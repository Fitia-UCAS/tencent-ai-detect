// Counts native hosts across repeated relay crashes.
//
// A single crash was observed leaving the original host alive with no child while a
// second host starts. One stale host is harmless because nothing can command it once
// its port is gone, but if the count climbs with every crash the machine accumulates
// unreachable hosts, and any one of them could later spawn a relay and fight over the
// port. This repeats the crash several times to see whether the count is bounded.
const { spawnSync } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const { belongs } = require('./clean-processes.cjs');
const { relayPidForPort } = require('./find-relay-pid.cjs');

const RELAY_PORT = 9420;
const EXT = path.join(__dirname, '..');
const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ROUNDS = Number(process.env.ROUNDS || 3);

const { sleep, launch } = require('./browser-harness.cjs');

function procs() {
    const result = spawnSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
        `ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.CommandLine)" }`
    ], { encoding: 'utf8', timeout: 12000 });

    return String(result.stdout || '')
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean)
        .map(line => {
            const a = line.indexOf('|');
            const b = line.indexOf('|', a + 1);
            return { pid: Number(line.slice(0, a)), parent: Number(line.slice(a + 1, b)), command: line.slice(b + 1) };
        })
        .filter(p => p.pid > 0)
        .filter(p => belongs(p, EXT));
}

function healthy() {
    return new Promise(resolve => {
        const socket = net.connect(RELAY_PORT, '127.0.0.1');
        let buffer = '';
        socket.setTimeout(1200);
        socket.once('connect', () => socket.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
        socket.on('data', c => { buffer += c; });
        socket.on('close', () => resolve(/zq-local-relay-v1/.test(buffer)));
        socket.on('timeout', () => { socket.destroy(); resolve(false); });
        socket.on('error', () => resolve(false));
    });
}

function relayPid() {
    // Never terminate a listener unless the OS attributes it to this checkout's
    // exact scripts/relay.cjs entry point. A matching /health marker is not proof.
    return relayPidForPort(RELAY_PORT);
}

(async () => {
    let session = null;

    try {
        const pre = procs();
        if (pre.length) {
            process.stdout.write(`refusing to start: ${pre.length} process(es) from a previous run\n`);
            return;
        }
        if (await healthy()) {
            process.stdout.write('refusing to start: port 9420 already has a healthy relay; stop it explicitly before this destructive test\n');
            return;
        }

        session = await launch({
            browser: BROWSER,
            port: 9383,
            prefix: 'zqhostcount',
            args: [`--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`]
        });

        let relay = null;
        for (let i = 0; i < 45 && !relay; i++) {
            await sleep(1000);
            if (await healthy()) relay = await relayPid();
        }

        if (!relay) {
            process.stdout.write('relay never started\n');
            return;
        }

        for (let round = 1; round <= ROUNDS; round++) {
            const list = procs();
            const hosts = list.filter(p => /nm-host/.test(p.command));
            const relays = list.filter(p => /relay\.cjs/.test(p.command));
            process.stdout.write(`round ${round}: ${hosts.length} host(s) [${hosts.map(h => h.pid).join(',')}] ${relays.length} relay(s)\n`);

            process.kill(relay);
            await sleep(1500);

            let next = null;
            for (let i = 0; i < 150 && !next; i++) {
                await sleep(1000);
                if (await healthy()) {
                    const now = await relayPid();
                    if (now && now !== relay) next = now;
                }
            }

            if (!next) {
                process.stdout.write(`round ${round}: relay did not recover\n`);
                return;
            }

            relay = next;
        }

        const finalList = procs();
        const finalHosts = finalList.filter(p => /nm-host/.test(p.command));
        process.stdout.write(`\nfinal: ${finalHosts.length} host(s) after ${ROUNDS} crash(es)\n`);

        // Closing the browser is the only thing that reliably removes them.
        await session.cleanup();
        session = null;
        await sleep(4000);

        const afterClose = procs();
        process.stdout.write(`after browser closed: ${afterClose.length} process(es) left\n`);
        afterClose.forEach(p => process.stdout.write(`  pid=${p.pid} ${/nm-host/.test(p.command) ? 'host' : 'relay'}\n`));
    } catch (error) {
        process.stdout.write(`error: ${error.message}\n`);
        process.exitCode = 1;
    } finally {
        if (session) await session.cleanup();
    }
})();
