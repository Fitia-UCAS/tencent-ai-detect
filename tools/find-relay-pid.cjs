// Resolve a local relay listener to an OS process, without trusting HTTP
// metadata. Used exclusively by Windows maintenance and crash-recovery tests.
// The OS port owner and the expected script path must BOTH match; otherwise
// return null. This is a safety guard against accidentally killing other apps,
// not an authentication boundary against a hostile same-user OS process.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

// This file used to resolve a single hard-coded tools/relay.cjs, which exists nowhere, so the
// lookup returned null everywhere and every caller that needs to attribute the port - stop-relay,
// the crash-recovery test, the native lifecycle test - could not identify the relay at all.
//
// The relay lives at src/relay/server.cjs. The lookup still accepts a scripts/relay.cjs candidate,
// because a relay launched from an older checkout or a manual `node scripts/relay.cjs` is still
// something this tool should be able to attribute rather than mistake for a stranger on the port.
//
// Both spellings are checked against the files that actually exist in this checkout, so following
// the branch needs no edit here.
const ABSOLUTE_CANDIDATES = [
    path.join(ROOT, 'src', 'relay', 'server.cjs'),
    path.join(ROOT, 'scripts', 'relay.cjs')
];

function existingScripts() {
    return ABSOLUTE_CANDIDATES.filter(file => {
        try {
            return fs.existsSync(file);
        } catch {
            return false;
        }
    });
}

// Relative spellings, for a launch the OS cannot resolve to a checkout. Best-effort by design and
// documented as such in the comment below: it can match another checkout using the same relative
// script name.
const RELATIVE_PATTERNS = [
    'src[\\\\/]relay[\\\\/]server\\.cjs',
    'scripts[\\\\/]relay\\.cjs'
];

// --- Linux ---------------------------------------------------------------------------------------
//
// The same attribution as the Windows path below, read from /proc instead of CIM. It exists because
// the test that depends on it - listener is a child of the host that started it - is a real assertion
// about process ownership, and skipping it wherever the platform differs means the release workflow
// checks less than a developer's machine does.
//
// /proc is used rather than `ss` or `lsof` because neither is guaranteed present; the kernel table is.

// Parses one of /proc/net/tcp or /proc/net/tcp6 and returns the inode of every socket listening on
// `port`. Lines are `sl local_address rem_address st ...`, addresses as HEXIP:HEXPORT, and st 0A is
// LISTEN. The inode is the ninth field.
function listeningInodes(port, readFile) {
    const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
    const inodes = [];

    for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
        let raw;
        try {
            raw = String(readFile(table, 'utf8'));
        } catch (_) {
            continue;
        }

        for (const line of raw.split('\n').slice(1)) {
            const fields = line.trim().split(/\s+/);
            if (fields.length < 10) continue;

            const local = fields[1];
            if (!local || !local.endsWith(':' + hexPort)) continue;
            if (fields[3] !== '0A') continue;

            // An inode of 0 means the kernel has not assigned one, so it cannot be matched to a
            // process; treating it as a match would attribute the port to the wrong pid.
            if (fields[9] && fields[9] !== '0') inodes.push(fields[9]);
        }
    }

    return inodes;
}

// Whether this process was started from one of the relay scripts. /proc/<pid>/cmdline is
// NUL-separated, and the paths are compared with forward slashes because that is what a launch on
// Linux records.
function startedFromScript(pid, scriptPaths, readFile) {
    let raw;
    try {
        raw = String(readFile('/proc/' + pid + '/cmdline', 'utf8'));
    } catch (_) {
        return false;
    }

    const command = raw.split('\0').join(' ');

    for (const script of scriptPaths) {
        if (command.includes(script.split(path.sep).join('/'))) return true;
        if (command.includes(script)) return true;
    }

    for (const pattern of RELATIVE_PATTERNS) {
        if (new RegExp(pattern).test(command)) return true;
    }

    return false;
}

function linuxPidForPort(port, options) {
    const readFile = options.readFileSync ?? fs.readFileSync;
    const readdir = options.readdirSync ?? fs.readdirSync;
    const readlink = options.readlinkSync ?? fs.readlinkSync;

    const scriptPaths = options.scriptPath
        ? [options.scriptPath]
        : (options.scriptPaths ?? existingScripts());
    if (!scriptPaths.length) return null;

    const inodes = listeningInodes(port, readFile);
    if (!inodes.length) return null;

    const found = new Set();

    for (const name of readdir('/proc')) {
        if (!/^\d+$/.test(name)) continue;

        let fds;
        try {
            fds = readdir('/proc/' + name + '/fd');
        } catch (_) {
            // Another user's process, or one that exited between the listing and this read.
            continue;
        }

        for (const fd of fds) {
            let target;
            try {
                target = String(readlink('/proc/' + name + '/fd/' + fd));
            } catch (_) {
                continue;
            }

            const match = /^socket:\[(\d+)\]$/.exec(target);
            if (!match || !inodes.includes(match[1])) continue;

            if (startedFromScript(name, scriptPaths, readFile)) found.add(Number(name));
            break;
        }
    }

    // Anything other than a single answer is reported as unattributed: two processes in one port's
    // socket table means this cannot say which one owns it.
    if (found.size !== 1) return null;

    const pid = [...found][0];
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function relayPidForPort(port, options = {}) {
    const platform = options.platform ?? process.platform;
    const run = options.spawnSync ?? spawnSync;
    const scriptPaths = options.scriptPath
        ? [options.scriptPath]
        : (options.scriptPaths ?? existingScripts());

    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (!scriptPaths.length) return null;

    if (platform === 'linux') return linuxPidForPort(port, { ...options, scriptPaths });
    if (platform !== 'win32') return null;

    // PowerShell single-quoted literals escape only single quotes. The script paths come from our
    // current checkout, never from a network response.
    const quoted = scriptPaths.map(file => "'" + file.replace(/'/g, "''") + "'");
    const relative = RELATIVE_PATTERNS.map(pattern => "'" + pattern.replace(/'/g, "''") + "'");

    const script = [
        `$targets = @(${quoted.join(', ')})`,
        `$relatives = @(${relative.join(', ')})`,
        `$connections = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue)`,
        'foreach ($c in $connections) {',
        "  if ($c.LocalAddress -ne '127.0.0.1') { continue }",
        '  $proc = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $c.OwningProcess) -ErrorAction SilentlyContinue',
        "  if ($null -eq $proc -or $proc.Name -ine 'node.exe' -or [string]::IsNullOrEmpty($proc.CommandLine)) { continue }",
        // Exact absolute path is a reliable checkout-level match. The Native Host
        // launches that way. A manual `node scripts/relay.cjs` uses a relative path,
        // which Win32_Process.CommandLine does not resolve to a working directory.
        // Keep that compatibility case explicit; it is only a best-effort match and
        // can match another checkout with the same relative script name.
        //
        // CommandLine keeps whatever separators the caller typed, so a launch using
        // forward slashes ("E:/.../server.cjs") would never match an escaped
        // backslash path. Normalising the command line for comparison only avoids
        // that without loosening what counts as a match.
        '  $comparable = $proc.CommandLine -replace \'/\', \'\\\'',
        '  $matched = $false',
        '  foreach ($target in $targets) {',
        `    if ($comparable -match ('(^|[\\s"])' + [regex]::Escape($target) + '($|[\\s"])')) { $matched = $true; break }`,
        '  }',
        '  if (-not $matched) {',
        '    foreach ($pattern in $relatives) {',
        '      if ($comparable -match $pattern) { $matched = $true; break }',
        '    }',
        '  }',
        '  if ($matched) { Write-Output $proc.ProcessId }',
        '}'
    ].join('\n');

    let result;
    try {
        result = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
            encoding: 'utf8', windowsHide: true, timeout: 7000
        });
    } catch (_) { return null; }
    if (!result || result.error || result.status !== 0) return null;

    const lines = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean);
    if (lines.some(line => !/^\d+$/.test(line.trim()))) return null;
    const pids = [...new Set(lines.map(line => Number(line.trim())))];
    if (pids.length !== 1 || !Number.isSafeInteger(pids[0]) || pids[0] <= 0) return null;
    return pids[0];
}

module.exports = { relayPidForPort, existingScripts };
