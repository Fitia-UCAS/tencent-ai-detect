// Resolve a local relay listener to an OS process, without trusting HTTP
// metadata. Used exclusively by Windows maintenance and crash-recovery tests.
// The OS port owner and the expected script path must BOTH match; otherwise
// return null. This is a safety guard against accidentally killing other apps,
// not an authentication boundary against a hostile same-user OS process.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

// The relay does not live in the same place on every branch: dev keeps it at
// src/relay/server.cjs, main at scripts/relay.cjs (see scripts/switch-branch.cjs). This file used
// to resolve a single hard-coded tools/relay.cjs, which exists on neither branch, so the lookup
// returned null everywhere and every caller that needs to attribute the port - stop-relay, the
// crash-recovery test, the native lifecycle test - could not identify the relay at all.
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

function relayPidForPort(port, options = {}) {
    const platform = options.platform ?? process.platform;
    const run = options.spawnSync ?? spawnSync;
    const scriptPaths = options.scriptPath
        ? [options.scriptPath]
        : (options.scriptPaths ?? existingScripts());

    if (platform !== 'win32') return null;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (!scriptPaths.length) return null;

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
