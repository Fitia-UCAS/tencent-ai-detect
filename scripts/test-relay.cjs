// Owns the relay process for a test run.
//
// Tests must not hunt for processes by name: that kills unrelated Node programs,
// including a native host the user's own browser is relying on. A relay started
// here is tracked by PID and is the only thing this module will terminate.
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const RELAY_SCRIPT = path.join(__dirname, 'relay.cjs');
const DEFAULT_PORT = 9420;

function relayHealthy(port) {
  return new Promise(resolve => {
    const request = http.get(
      { host: '127.0.0.1', port, path: '/health', timeout: 900 },
      response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => {
          try {
            resolve(JSON.parse(body).ok === true);
          } catch (e) {
            resolve(false);
          }
        });
      }
    );

    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

// Starts a relay and waits for it to answer /health.
async function startRelay({ port = DEFAULT_PORT, idleMs = 0 } = {}) {
  const child = spawn(process.execPath, [RELAY_SCRIPT], {
    stdio: 'ignore',
    env: Object.assign({}, process.env, {
      RELAY_PORT: String(port),
      RELAY_IDLE_MS: String(idleMs)
    })
  });

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await relayHealthy(port)) {
      return {
        pid: child.pid,
        port,
        stop: () => stopRelay(child)
      };
    }
    await new Promise(r => setTimeout(r, 150));
  }

  stopRelay(child);
  throw new Error(`relay did not become healthy on port ${port}`);
}

// Terminates only the process this module started.
function stopRelay(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    const timer = setTimeout(resolve, 1500);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      child.kill();
    } catch (e) {
      clearTimeout(timer);
      resolve();
    }
  });
}

module.exports = { startRelay, stopRelay, relayHealthy, DEFAULT_PORT };
