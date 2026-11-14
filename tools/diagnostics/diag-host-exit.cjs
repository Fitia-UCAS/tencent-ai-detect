// Native Host lifecycle measured without a browser.
//
// Reading residue from real browser sessions is unreliable on this machine: another Edge
// instance already has the extension loaded, so a host that appears after a test session
// closes may belong to it. This drives the host directly over the same stdin/stdout protocol
// the browser uses, on its own port, so every process involved is one this test started.
//
// Two questions are answered:
//   1. When the browser side goes away (stdin EOF), does the host exit?
//   2. Does the relay it started exit with it, or is the port left occupied?
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const BAT = path.join(__dirname, '..', '..', 'host', 'nm-host.bat');
const PORT = 19440;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function frame(message) {
    const json = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(json.length, 0);
    return Buffer.concat([header, json]);
}

function alive(pid) {
    const r = spawnSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `if (Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`
    ], { encoding: 'utf8', timeout: 8000 });
    return String(r.stdout || '').trim() === 'yes';
}

function relayHealthy() {
    return new Promise(resolve => {
        const socket = net.connect(PORT, '127.0.0.1');
        let buffer = '';
        socket.setTimeout(1200);
        socket.once('connect', () => socket.write('GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
        socket.on('data', c => { buffer += c; });
        socket.on('close', () => resolve(/zq-local-relay-v1/.test(buffer)));
        socket.on('timeout', () => { socket.destroy(); resolve(false); });
        socket.on('error', () => resolve(false));
    });
}

function portOwner() {
    const r = spawnSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue |` +
        ` Where-Object { $_.LocalAddress -eq '127.0.0.1' } | ForEach-Object { $_.OwningProcess }`
    ], { encoding: 'utf8', timeout: 8000 });
    const pid = Number(String(r.stdout || '').trim().split(/\r?\n/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function nodeChildOf(pid) {
    const r = spawnSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${Number(pid)}' | ForEach-Object { "$($_.ProcessId)|$($_.Name)" }`
    ], { encoding: 'utf8', timeout: 8000 });
    return String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean)
        .map(line => line.split('|'))
        .filter(([, name]) => /node\.exe/i.test(name))
        .map(([id]) => Number(id))[0] || null;
}

(async () => {
    if (await relayHealthy()) {
        process.stdout.write(`port ${PORT} already has a relay; stopping\n`);
        return;
    }

    // Start it the way the browser does: through the batch launcher, with a stdin pipe.
    const launcher = spawn('cmd.exe', ['/c', BAT], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: Object.assign({}, process.env, { RELAY_PORT: String(PORT) })
    });

    let stdout = '';
    launcher.stdout.on('data', c => { stdout += String(c); });
    launcher.stderr.on('data', () => {});

    await sleep(2000);

    const hostPid = nodeChildOf(launcher.pid);
    if (!hostPid) {
        process.stdout.write('the launcher did not start a host\n');
        try { launcher.kill(); } catch (e) {}
        return;
    }

    // Ask for a relay.
    launcher.stdin.write(frame({ type: 'ensure' }));

    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
        await sleep(200);
        up = await relayHealthy();
    }

    const relayPid = portOwner();

    process.stdout.write(`host pid=${hostPid} alive=${alive(hostPid)}\n`);
    process.stdout.write(`relay up=${up} owner=${relayPid}\n\n`);

    // The browser going away closes the host's stdin. That is the documented exit path.
    launcher.stdin.end();
    launcher.stdin.destroy();

    await sleep(2500);

    const hostAfter = alive(hostPid);
    const relayAfter = relayPid ? alive(relayPid) : null;
    const portAfter = await relayHealthy();

    process.stdout.write('after stdin EOF (what happens when the browser exits)\n');
    process.stdout.write(`  host still running:  ${hostAfter}\n`);
    process.stdout.write(`  relay still running: ${relayAfter}\n`);
    process.stdout.write(`  port still serving:  ${portAfter}\n`);
    process.stdout.write(`  port owner now:      ${portOwner()}\n`);

    if (!hostAfter && !relayAfter && !portAfter) {
        process.stdout.write('\nverdict: the host exits on stdin EOF and takes its relay with it; nothing is left behind\n');
    } else {
        process.stdout.write('\nverdict: something outlived the browser side\n');
    }

    // Leave nothing behind from this test.
    for (const pid of [hostPid, relayPid, portOwner()].filter(Boolean)) {
        spawnSync('powershell', ['-NoProfile', '-Command',
            `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`], { timeout: 8000 });
    }
    try { launcher.kill(); } catch (e) {}
})();
