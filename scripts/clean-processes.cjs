// Removes only this checkout's actual relay and Native Host entry points.
//
// Relative command lines are intentionally not matched: without the process
// working directory they cannot prove which checkout launched the process.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const PROJECT = path.resolve(__dirname, '..');

function normalizeRoot(value) {
    return path.win32.normalize(String(value).replace(/\//g, '\\'))
        .replace(/\\+$/, '')
        .toLowerCase();
}

// Split a command line into its quoted and bare arguments. Quoted segments keep their
// spaces; bare ones are separated by whitespace.
function commandArguments(commandLine) {
    const text = String(commandLine || '');
    const args = [];
    const quoted = /"([^"]*)"/g;
    let match;

    while ((match = quoted.exec(text)) !== null) args.push(match[1]);

    for (const token of text.replace(/"[^"]*"/g, ' ').split(/\s+/)) {
        if (token) args.push(token);
    }

    return args;
}

// The launcher spec for the host is
//   node "%~dp0..\scripts\nm-host.cjs"
// so its command line carries a literal "host\..\scripts" segment. Comparing raw text
// against the resolved path therefore misses the only host the browser actually starts,
// which silently reduces clean:processes to relay-only cleanup. Normalising each argument
// as a Windows path resolves the ".." before the comparison, without loosening what counts
// as a match: the result must still equal this checkout's exact script path, so
// scripts/test-relay.cjs and sibling checkouts stay unmatched.
function matchesEntryPoint(commandLine, scriptName, projectRoot = PROJECT) {
    const root = normalizeRoot(projectRoot);
    const target = path.win32.normalize(`${root}\\scripts\\${scriptName}`).toLowerCase();

    for (const argument of commandArguments(commandLine)) {
        const value = argument.trim();
        if (!value) continue;

        // Only consider arguments that name this script, then resolve the path.
        const normalized = path.win32.normalize(value.replace(/\//g, '\\'));
        if (normalized.toLowerCase() === target) return true;
    }

    return false;
}

function processKind(proc, projectRoot = PROJECT) {
    const command = proc && proc.command;
    if (matchesEntryPoint(command, 'nm-host.cjs', projectRoot)) return 'nm-host';
    if (matchesEntryPoint(command, 'relay.cjs', projectRoot)) return 'relay';
    return null;
}

function belongs(proc, projectRoot = PROJECT) {
    return processKind(proc, projectRoot) !== null;
}

function list() {
    const script =
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
        `ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.CommandLine)" }`;

    const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', timeout: 12000, windowsHide: true
    });

    if (result.error || result.status !== 0) {
        throw new Error(`could not enumerate node.exe processes: ${result.error?.message || result.stderr || result.status}`);
    }

    return String(result.stdout || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
            const first = line.indexOf('|');
            const second = line.indexOf('|', first + 1);
            if (first < 1 || second < 0) return null;
            return {
                pid: Number(line.slice(0, first)),
                parent: Number(line.slice(first + 1, second)),
                command: line.slice(second + 1)
            };
        })
        .filter(p => p && Number.isInteger(p.pid) && p.pid > 0);
}

async function main() {
    if (process.platform !== 'win32') {
        throw new Error('clean:processes is supported only on Windows');
    }

    const mine = list().filter(proc => belongs(proc));

    if (!mine.length) {
        process.stdout.write('no verified relay or native host from this checkout is running\n');
        return;
    }

    // Kill the host before its relay: the host may respawn a missing child.
    const ordered = [...mine].sort((a, b) =>
        (processKind(b) === 'nm-host' ? 1 : 0) - (processKind(a) === 'nm-host' ? 1 : 0)
    );

    for (const proc of ordered) {
        const kind = processKind(proc);
        spawnSync('powershell', [
            '-NoProfile', '-NonInteractive', '-Command',
            `Stop-Process -Id ${proc.pid} -Force -ErrorAction SilentlyContinue`
        ], { encoding: 'utf8', timeout: 8000, windowsHide: true });

        const alive = list().some(candidate => candidate.pid === proc.pid);
        process.stdout.write(
            alive
                ? `could not stop ${kind} pid=${proc.pid}\n`
                : `stopped ${kind} pid=${proc.pid}\n`
        );
    }

    await new Promise(resolve => setTimeout(resolve, 1200));
    const remaining = list().filter(proc => belongs(proc));

    if (remaining.length) {
        process.stdout.write(`${remaining.length} verified process(es) still running\n`);
        process.exitCode = 1;
    } else {
        process.stdout.write('clean\n');
    }
}

if (require.main === module) {
    main().catch(error => {
        process.stderr.write(`clean:processes failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { belongs, processKind, matchesEntryPoint };
