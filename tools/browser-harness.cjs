// Shared browser harness for the probe scripts.
//
// The branded browsers re-launch themselves and hand off to the real browser
// process, so the spawned PID is useless for cleanup. Everything is matched by
// the throwaway --user-data-dir instead: kill those processes, then remove the
// directory. Leaves no orphaned windows and no temp profiles behind.
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function httpJson(port, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method }, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const listeners = [];
    let id = 0;

    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
        return;
      }
      listeners.forEach(fn => fn(msg));
    };
    ws.onerror = () => reject(new Error('cdp connect failed'));
    ws.onopen = () => resolve({
      // sessionId targets one attached target in flattened mode; omit it for the page itself.
      send: (method, params = {}, sessionId = undefined) => new Promise((res, rej) => {
        const msgId = ++id;
        pending.set(msgId, { res, rej });
        const frame = { id: msgId, method, params };
        if (sessionId) frame.sessionId = sessionId;
        ws.send(JSON.stringify(frame));
      }),
      on: fn => listeners.push(fn),
      close: () => ws.close()
    });
  });
}

function pidsForProfile(profile) {
  if (process.platform !== 'win32') return [];
  // PowerShell single-quoted strings treat backslashes literally, so only a
  // quote needs escaping here. Doubling the backslashes would never match.
  const literal = profile.replace(/'/g, "''");
  const script = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' or Name='chrome.exe'" | ` +
    `Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${literal}') } | ` +
    `Select-Object -ExpandProperty ProcessId`;
  const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  return String(out.stdout || '')
    .split(/\r?\n/)
    .map(line => Number(line.trim()))
    .filter(n => Number.isInteger(n) && n > 0);
}

// Kill every browser process rooted at this profile and delete the profile.
async function killProfile(profile) {
  for (let round = 0; round < 5; round++) {
    const pids = pidsForProfile(profile);
    if (pids.length === 0) break;
    for (const pid of pids) {
      try {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } catch (e) {
      }
    }
    await sleep(600);
  }

  for (let round = 0; round < 5; round++) {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
      return;
    } catch (e) {
      await sleep(500);
    }
  }
}

// Start a throwaway browser with a unique profile. Caller must call cleanup().
async function launch({ browser, port, args = [], prefix = 'zq' }) {
  const profile = path.join(os.tmpdir(), `${prefix}-${port}-${Date.now()}`);
  fs.mkdirSync(profile, { recursive: true });

  const child = spawn(browser, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...args,
    'about:blank'
  ], { stdio: 'ignore', detached: false });

  const deadline = Date.now() + 20000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      if (await httpJson(port, '/json/version')) {
        up = true;
        break;
      }
    } catch (e) {
    }
    await sleep(300);
  }

  if (!up) {
    await killProfile(profile);
    throw new Error(`browser did not expose devtools on port ${port} (profile ${profile})`);
  }

  return { child, profile, cleanup: () => killProfile(profile) };
}

// Kill every leftover profile this project created.
//
// Matching is restricted to the exact prefixes launch() uses, plus the trailing
// "-<port>-<timestamp>" tail. A loose prefix match would let this delete
// unrelated directories that merely start with the same letters.
const PROFILE_PREFIXES = ['zq', 'zqab', 'zqcdp', 'zqe2e', 'zqext', 'zqfallback', 'zqfp', 'zqmech', 'zqrelay', 'zqroute', 'zqverify', 'zqws'];
const PROFILE_PATTERN = new RegExp(`^(?:${PROFILE_PREFIXES.join('|')})-\\d+-\\d+$`);

async function cleanupAll() {
  const temp = os.tmpdir();

  let entries;
  try {
    entries = fs.readdirSync(temp);
  } catch (e) {
    return;
  }

  for (const name of entries) {
    if (!PROFILE_PATTERN.test(name)) continue;
    await killProfile(path.join(temp, name));
  }
}

module.exports = { sleep, httpJson, cdp, launch, killProfile, cleanupAll };
