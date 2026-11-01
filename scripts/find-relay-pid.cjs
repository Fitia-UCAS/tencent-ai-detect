// Resolve a local relay listener to an OS process, without trusting HTTP
// metadata. Used exclusively by Windows maintenance and crash-recovery tests.
// The OS port owner and the expected script path must BOTH match; otherwise
// return null. This is a safety guard against accidentally killing other apps,
// not an authentication boundary against a hostile same-user OS process.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RELAY_SCRIPT = path.resolve(__dirname, 'relay.cjs');

function relayPidForPort(port, options = {}) {
  const platform = options.platform ?? process.platform;
  const run = options.spawnSync ?? spawnSync;
  const scriptPath = options.scriptPath ?? RELAY_SCRIPT;
  if (platform !== 'win32') return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  // PowerShell single-quoted literals escape only single quotes. The script
  // filename comes from our current checkout, never from a network response.
  const quoted = scriptPath.replace(/'/g, "''");
  const script = [
    `$target = '${quoted}'`,
    `$connections = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue)`,
    'foreach ($c in $connections) {',
    "  if ($c.LocalAddress -ne '127.0.0.1') { continue }",
    '  $proc = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $c.OwningProcess) -ErrorAction SilentlyContinue',
    "  if ($null -eq $proc -or $proc.Name -ine 'node.exe' -or [string]::IsNullOrEmpty($proc.CommandLine)) { continue }",
    // Exact absolute path is a reliable checkout-level match. The Native Host
    // launches that way. Manual `node scripts/relay.cjs` uses a relative path,
    // which Win32_Process.CommandLine does not resolve to a working directory.
    // Keep that compatibility case explicit; it is only a best-effort match and
    // can match another checkout with the same relative script name.
    //
    // CommandLine keeps whatever separators the caller typed, so a launch using
    // forward slashes ("E:/.../relay.cjs") would never match an escaped
    // backslash path. Normalising the command line for comparison only avoids
    // that without loosening what counts as a match.
    '  $comparable = $proc.CommandLine -replace \'/\', \'\\\'',
    '  $patterns = @(',
    `    ('(^|[\\s"])' + [regex]::Escape($target) + '($|[\\s"])'),`,
    '    \'(^|[\\s"])scripts[\\\\/]relay\\.cjs($|[\\s"])\'',
    '  )',
    '  foreach ($pattern in $patterns) {',
    '    if ($comparable -match $pattern) { Write-Output $proc.ProcessId; break }',
    '  }',
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

module.exports = { relayPidForPort };
