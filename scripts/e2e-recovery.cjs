// Verifies crash recovery: the relay dies while the native host stays alive, and
// the worker must bring it back on the next keepalive tick.
//
// This is the case the review found unproven: a live nativePort does not mean a
// live relay, so the old `if (!body && !nativePort)` never fired.
//
// The test obtains the listener PID from Windows OS process information and
// verifies its script path. Never trust an unauthenticated /health PID.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.resolve(__dirname, '..');
const EXT_ID = process.env.EXT_ID || 'kdjgfockdecdbadmpbjgflmiffdiffhp';
const PORT = 9385;
const RELAY_PORT = 9420;

const { sleep, httpJson, launch } = require('./browser-harness.cjs');
const { relayHealthy } = require('./test-relay.cjs');
const { relayPidForPort } = require('./find-relay-pid.cjs');

const failures = [];
const ok = m => process.stdout.write(`  ok    ${m}\n`);
const fail = m => { failures.push(m); process.stdout.write(`  FAIL  ${m}\n`); };

// A port owner that cannot be identified as THIS checkout's relay is unsafe
// to terminate. Failing closed is intentional for this destructive test.
function relayPid() {
  return relayPidForPort(RELAY_PORT);
}

// Every process listening on the relay port. A crash must leave exactly one owner:
// two would mean a stale relay was never torn down and the two would answer the page
// in turn.
function relayPids() {
  if (process.platform !== 'win32') return [];

  const result = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Get-NetTCPConnection -LocalPort ${RELAY_PORT} -State Listen -ErrorAction SilentlyContinue |` +
    ` Where-Object { $_.LocalAddress -eq '127.0.0.1' } | ForEach-Object { $_.OwningProcess }`
  ], { encoding: 'utf8' });

  return String(result.stdout || '')
    .split(/\r?\n/)
    .map(line => Number(line.trim()))
    .filter(value => Number.isInteger(value) && value > 0);
}

// The native host is the relay's parent. This records which host owns the
// recovered relay; a changed PID is informational because an MV3 worker restart
// can establish a fresh Native Messaging connection.
// Read-only: nothing is terminated by this lookup.
function parentPidOf(pid) {
  if (!pid || process.platform !== 'win32') return null;

  const result = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").ParentProcessId`
  ], { encoding: 'utf8' });

  const value = Number(String(result.stdout || '').trim());
  return Number.isInteger(value) && value > 0 ? value : null;
}

async function waitFor(predicate, attempts = 60, gap = 500) {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return true;
    await sleep(gap);
  }
  return false;
}

(async () => {
  let session = null;

  try {
    if (await relayHealthy(RELAY_PORT)) {
      fail('a relay is already running; stop it first so the test owns the lifecycle');
    } else {
      ok('no relay running before the test');

      session = await launch({
        browser: BROWSER,
        port: PORT,
        prefix: 'zqcrash',
        args: [
          '--disable-features=DisableLoadExtensionCommandLineSwitch',
          `--disable-extensions-except=${EXT}`,
          `--load-extension=${EXT}`
        ]
      });

      const started = await waitFor(() => relayHealthy(RELAY_PORT), 40, 500);
      started ? ok('relay started with the extension') : fail('relay did not start');

      const before = await relayPid();

      if (!before) {
        fail('could not read the relay pid; cannot test crash recovery');
      } else {
        const hostBefore = parentPidOf(before);
        ok(`relay ${before} running under host ${hostBefore || 'unknown'}`);

        // Kill only that process. The native host is left running on purpose —
        // that is exactly the state the worker used to fail to recover from.
        try {
          process.kill(before);
        } catch (e) {
          fail('could not kill the relay: ' + e.message);
        }

        const died = await waitFor(async () => !(await relayHealthy(RELAY_PORT)), 20, 300);
        died ? ok(`relay ${before} killed and stopped`) : fail('relay survived the kill');

        // Keepalive runs on a 1 minute alarm. The recovery path is also reached
        // when the worker is woken, so give it a full alarm period plus slack.
        const recovered = await waitFor(async () => {
          if (!(await relayHealthy(RELAY_PORT))) return false;
          const now = await relayPid();
          return !!now && now !== before;
        }, 150, 1000);

        if (!recovered) {
          fail('relay did not recover after the crash');
        } else {
          const after = await relayPid();
          const hostAfter = parentPidOf(after);

          ok(`relay recovered with a new pid (${after})`);

          // The requirement is that the port ends up with a single working relay. Whether
          // it is supervised by the same host process is not something the worker can
          // promise: MV3 tears the worker down after ~30s idle, that loses the in-memory
          // native port, and the next alarm connects a fresh host. Treat reuse as
          // information, and assert what actually matters — one owner, still serving.
          if (!hostBefore || !hostAfter) {
            process.stdout.write('  note  host pid unavailable, reuse could not be observed\n');
          } else if (hostBefore === hostAfter) {
            ok(`recovery reused the original host connection (pid ${hostAfter})`);
          } else {
            process.stdout.write(
              `  note  a new host was connected (${hostBefore} -> ${hostAfter}); the worker had lost its port\n`
            );
          }

          const listeners = await relayPids();
          if (listeners.length === 1 && listeners[0] === after) {
            ok('exactly one relay owns the port after recovery');
          } else {
            fail(`the port is owned by [${listeners.join(', ')}] instead of the recovered relay alone`);
          }
        }
      }
    }
  } catch (e) {
    fail('exception: ' + String(e && e.message ? e.message : e));
  } finally {
    if (session) await session.cleanup();
  }

  if (failures.length) {
    process.stdout.write(`\n${failures.length} check(s) failed\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('\nall checks passed\n');
  }
})();
