// Diagnose and repair the local relay without touching the browser or the desktop.
//
// The relay is a child of the native messaging host, which the browser starts and keeps alive.
// When a relay spawn fails - the script was mid-checkout, an update moved it, a node upgrade
// removed the binary - the host logs the failure and retries on its next keepalive, but the
// browser keeps the dead nativePort for the rest of the session. The visible symptom is an
// extension that answers "Invalid request" or never rotates, and restarting explorer.exe clears
// it because that tears down the whole host chain.
//
// This reaches the same end state without the restart: stop every stale host and relay that
// belongs to this checkout, start one relay, and prove it answers.
//
// Order matters. The stale processes are stopped first, because a host that is mid-retry would
// otherwise spawn a second relay on the same port and the new one would fail to bind.
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const PROJECT = path.resolve(__dirname, '..');
const RELAY_SCRIPT = path.join(PROJECT, 'src', 'relay', 'server.cjs');
const HOST_SCRIPT = path.join(PROJECT, 'src', 'host', 'native-host.cjs');
const DEFAULT_PORT = 9420;
const HEALTH_SERVICE = 'zq-local-relay-v1';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function log(line) {
    process.stdout.write(line + '\n');
}

// Reads the service marker, not just a status code: another app could be holding the port.
function probe(port) {
    return new Promise(resolve => {
        const request = http.get(
            { host: '127.0.0.1', port, path: '/health', timeout: 1200 },
            response => {
                let body = '';
                response.setEncoding('utf8');
                response.on('data', chunk => { body += chunk; });
                response.on('end', () => {
                    try {
                        const parsed = JSON.parse(body);
                        resolve({ ok: parsed.ok === true, service: parsed.service || null });
                    } catch {
                        resolve({ ok: false, service: null });
                    }
                });
            }
        );

        request.on('timeout', () => { request.destroy(); resolve({ ok: false, service: null }); });
        request.on('error', () => resolve({ ok: false, service: null }));
    });
}

function listNodeProcesses() {
    const script =
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
        `ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.CommandLine)" }`;

    const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', timeout: 15000, windowsHide: true
    });

    if (result.error || result.status !== 0) return [];

    return String(result.stdout || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            const first = line.indexOf('|');
            const second = line.indexOf('|', first + 1);
            return {
                pid: Number(line.slice(0, first)),
                ppid: Number(line.slice(first + 1, second)),
                command: line.slice(second + 1)
            };
        })
        .filter(proc => Number.isFinite(proc.pid) && proc.pid > 0);
}

// Only this checkout's entry points count. A relative command line cannot prove the working
// directory, so it is left alone rather than guessed at.
function ownedKind(command) {
    const text = String(command || '');
    const normalize = value => path.win32.normalize(value.replace(/\//g, '\\')).toLowerCase();
    const relay = normalize(RELAY_SCRIPT);
    const host = normalize(HOST_SCRIPT);

    for (const match of text.matchAll(/"([^"]*)"|(\S+)/g)) {
        const token = (match[1] || match[2] || '').trim();
        if (!token) continue;

        const normalized = normalize(token);
        if (normalized === relay) return 'relay';
        if (normalized === host) return 'nm-host';
    }

    return null;
}

function kill(pid) {
    spawnSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`
    ], { encoding: 'utf8', timeout: 8000, windowsHide: true });
}

function startRelay(port) {
    const child = spawn(process.execPath, [RELAY_SCRIPT], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, RELAY_PORT: String(port) }
    });

    child.unref();
    return child.pid;
}

async function main() {
    const port = Number(process.env.RELAY_PORT) || DEFAULT_PORT;
    let repaired = false;

    // --- 1. The source has to be loadable, or every respawn fails the same way -------------
    if (!fs.existsSync(RELAY_SCRIPT)) {
        log(`fail  relay script is missing: ${RELAY_SCRIPT}`);
        log('      the checkout is incomplete; run git status and restore the file first');
        process.exitCode = 1;
        return;
    }

    const syntax = spawnSync(process.execPath, ['--check', RELAY_SCRIPT], { encoding: 'utf8' });
    if (syntax.status !== 0) {
        log('fail  relay script does not parse');
        log('      ' + String(syntax.stderr || '').split('\n')[0]);
        process.exitCode = 1;
        return;
    }
    log('ok    relay script parses');

    // --- 2. What is running, and does the port answer -------------------------------------
    const before = await probe(port);
    if (before.ok && before.service === HEALTH_SERVICE) {
        log(`ok    relay answers on ${port} (${HEALTH_SERVICE})`);
        log('\nnothing to repair');
        return;
    }

    log(before.service
        ? `warn  port ${port} is held by another service (${before.service})`
        : `warn  no relay answering on ${port}`);

    // --- 3. Stop the stale host and relay belonging to this checkout ----------------------
    const owned = listNodeProcesses()
        .map(proc => ({ ...proc, kind: ownedKind(proc.command) }))
        .filter(proc => proc.kind);

    if (!owned.length) {
        log('ok    no stale host or relay from this checkout');
    } else {
        for (const proc of owned) {
            kill(proc.pid);
            log(`stop  ${proc.kind} pid=${proc.pid}`);
        }
        repaired = true;
    }

    // The port has to be released before a new relay can bind it.
    for (let i = 0; i < 15; i += 1) {
        const still = await probe(port);
        if (!still.ok) break;
        await sleep(300);
    }

    // --- 4. Start one relay and prove it answers -----------------------------------------
    const pid = startRelay(port);
    let up = false;

    for (let i = 0; i < 40; i += 1) {
        const state = await probe(port);
        if (state.ok && state.service === HEALTH_SERVICE) { up = true; break; }
        await sleep(300);
    }

    if (!up) {
        log(`fail  relay did not answer on ${port} after start (pid ${pid})`);
        process.exitCode = 1;
        return;
    }

    log(`ok    relay listening on ${port} (pid ${pid})`);
    repaired = true;

    log('');
    log(repaired
        ? 'repaired. Reload the extension in edge://extensions only if the panel still shows an old error;'
        : 'no change was needed.');
    log('the page picks the relay up on its next keepalive, so no restart is required.');
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`doctor failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { probe, ownedKind, listNodeProcesses };
