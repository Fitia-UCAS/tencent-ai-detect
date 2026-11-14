// Switches the extension checkout between the two branches and leaves the relay running the same
// code as the files on disk.
//
// Committed to both branches on purpose: it has to exist whichever branch is checked out, since
// switching is exactly what it does. That is also why it cannot live on only one of them.
//
// Both branches live in one directory rather than one directory each. That is deliberate: the
// browser loads this exact path and the host registry points at it, while the two layouts put the
// relay in different places (`scripts/relay.cjs` on main, `src/relay/server.cjs` on dev). Two
// checkouts meant the relay kept running code from the branch that was no longer loaded, and the
// mismatch surfaced as "Invalid request" rather than as anything naming the cause.
//
// So a switch always does the same three things: check out the branch, stop the relay the old
// branch started, start the one the new branch ships. The browser still has to be told to reload,
// which is a click in edge://extensions and cannot be automated from here.
//
//   npm run switch:dev
//   npm run switch:main
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const PROJECT = path.resolve(__dirname, '..');

// Where each branch keeps the relay, and how to reach its health endpoint.
const LAYOUT = {
    main: { relay: path.join(PROJECT, 'scripts', 'relay.cjs'), entry: 'background.js' },
    dev: { relay: path.join(PROJECT, 'src', 'relay', 'server.cjs'), entry: 'src/background/index.js' }
};

const PORT = 9420;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = line => process.stdout.write(line + '\n');

function git(args) {
    const result = spawnSync('git', args, { cwd: PROJECT, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
    }
    return (result.stdout || '').trim();
}

function probe() {
    return new Promise(resolve => {
        const request = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 1200 }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => {
                try {
                    resolve(JSON.parse(body).ok === true);
                } catch {
                    resolve(false);
                }
            });
        });
        request.on('timeout', () => { request.destroy(); resolve(false); });
        request.on('error', () => resolve(false));
    });
}

// Stops only the relay this project started. A relative command line cannot prove ownership, so it
// is left alone instead of guessed at.
function stopRelays() {
    const normalize = value => path.win32.normalize(String(value).replace(/\//g, '\\')).toLowerCase();
    const owned = new Set(Object.values(LAYOUT).map(layout => normalize(layout.relay)));

    const listing = spawnSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
        `ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`
    ], { encoding: 'utf8', timeout: 15000, windowsHide: true });

    const stopped = [];

    for (const raw of String(listing.stdout || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;

        const cut = line.indexOf('|');
        const pid = Number(line.slice(0, cut));
        const command = line.slice(cut + 1);
        if (!Number.isFinite(pid) || pid <= 0) continue;

        const tokens = [...command.matchAll(/"([^"]*)"|(\S+)/g)]
            .map(match => (match[1] || match[2] || '').trim())
            .filter(Boolean);

        if (!tokens.some(token => owned.has(normalize(token)))) continue;

        spawnSync('powershell', [
            '-NoProfile', '-NonInteractive', '-Command',
            `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`
        ], { encoding: 'utf8', timeout: 8000, windowsHide: true });

        stopped.push(pid);
    }

    return stopped;
}

async function startRelay(relayPath) {
    const child = spawn(process.execPath, [relayPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: PROJECT,
        env: { ...process.env, RELAY_PORT: String(PORT) }
    });

    child.unref();

    for (let i = 0; i < 40; i += 1) {
        if (await probe()) return true;
        await sleep(300);
    }

    return false;
}

async function main() {
    const target = (process.argv[2] || '').toLowerCase();

    if (!LAYOUT[target]) {
        log(`usage: node ${__filename} <${Object.keys(LAYOUT).join('|')}>`);
        process.exitCode = 1;
        return;
    }

    // Switching with work in the tree would either fail halfway or lose it.
    const dirty = git(['status', '--porcelain']);
    if (dirty) {
        log('fail  the working tree has uncommitted changes:');
        log(dirty.split('\n').map(line => '      ' + line).join('\n'));
        log('\n      commit or stash them first; a checkout would carry them across branches');
        process.exitCode = 1;
        return;
    }

    const before = git(['rev-parse', '--abbrev-ref', 'HEAD']);

    log(`ok    on ${before} (${git(['rev-parse', '--short', 'HEAD'])})`);

    if (before !== target) {
        git(['checkout', target]);
        log(`ok    checked out ${target} (${git(['rev-parse', '--short', 'HEAD'])})`);
    } else {
        log(`ok    already on ${target}`);
    }

    const layout = LAYOUT[target];
    if (!fs.existsSync(layout.relay)) {
        log(`fail  ${target} has no relay at ${layout.relay}`);
        log('      the checkout is incomplete; restore it before switching');
        process.exitCode = 1;
        return;
    }

    // The old relay is running code that is no longer on disk, so it is stopped before the new one
    // starts. Leaving it would serve the previous branch's behaviour under the new branch's name.
    const stopped = stopRelays();
    if (stopped.length) log(`stop  relay pid ${stopped.join(', ')}`);

    for (let i = 0; i < 15; i += 1) {
        if (!(await probe())) break;
        await sleep(300);
    }

    const up = await startRelay(layout.relay);
    if (!up) {
        log(`fail  the relay did not answer on ${PORT}`);
        process.exitCode = 1;
        return;
    }

    log(`ok    relay up on ${PORT} from ${path.relative(PROJECT, layout.relay)}`);
    log('');
    log(`now on ${target}. Reload the extension in edge://extensions - the content script list`);
    log('differs between branches, so the browser keeps the old files until it is told to reload.');
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`switch failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { LAYOUT, stopRelays, probe };
