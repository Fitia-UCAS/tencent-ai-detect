// Adversarial check for stop-relay: a foreign listener that occupies the port and
// even imitates the health shape must not be signalled.
//
// Two cases are exercised: a listener with no service marker, and one that
// copies the marker but is not a relay process (its command line is not
// scripts/relay.cjs).
//
// The child is spawned asynchronously on purpose: spawnSync would block this
// process's event loop, so the fake listener could never answer /health and the
// refusal would come from a timeout instead of the logic under test.
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 9421;
const STOP = path.join(__dirname, '..', '..', 'tools', 'stop-relay.cjs');

function serve(body) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });

    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

function runStop() {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [STOP, String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('exit', code => resolve({ code, stdout, stderr }));
  });
}

const failures = [];
const ok = m => process.stdout.write(`  ok    ${m}\n`);
const fail = m => { failures.push(m); process.stdout.write(`  FAIL  ${m}\n`); };

const close = server => new Promise(r => server.close(r));

(async () => {
  // Case 1: no service marker at all.
  let server = await serve({ ok: true, pid: process.pid });

  let result = await runStop();
  if (result.code !== 0 && /did not report service/.test(result.stderr)) {
    ok('listener without service marker is refused');
  } else {
    fail(`expected service refusal, got code=${result.code} stderr=${result.stderr.trim()}`);
  }

  await close(server);

  // Case 2: correct marker, but the OS does not attribute the port to relay.cjs.
  server = await serve({ ok: true, service: 'zq-local-relay-v1' });

  result = await runStop();
  if (result.code !== 0 && /no verified relay owned by this checkout/.test(result.stderr)) {
    ok('marker alone is not enough; OS identity still required');
  } else {
    fail(`expected identity refusal, got code=${result.code} stderr=${result.stderr.trim()}`);
  }

  ok('test process survived both attempts');

  await close(server);

  if (failures.length) {
    process.stdout.write(`\n${failures.length} check(s) failed\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('\nall checks passed\n');
  }
})();
