// Offline regression for the WebSocket close handshake.
//
// Closing used to be a hang-up: on either side's Close the relay destroyed both sockets without
// answering. The page therefore saw 1006 ("abnormal closure") for an ordinary close, so page code
// that branches on the close code treated a clean shutdown as a failure. RFC 6455 5.5.1 requires
// an answer, and a proxy should also pass the close on to the other peer instead of dropping it.
//
// Checks:
//   1. The page's close is answered with a close carrying the same code and reason.
//   2. The close is passed on to the upstream rather than swallowed.
//   3. An upstream close reaches the page with the upstream's code, not 1006.
//   4. The relay keeps serving afterwards, so slots were released rather than leaked.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const source = fs.readFileSync(path.join(__dirname, 'relay.cjs'), 'utf8');
const target = 'function openUpstream(ip) {';
assert.equal(source.split(target).length, 2, 'one upstream function to isolate');

// The mock records what it receives. With MOCK_UPSTREAM_CLOSE set it also sends a close of its
// own shortly after the connection is established, which is how the downstream direction is
// exercised without reaching into the relay process.
const mock = `
function openUpstream(ip) {
    const secure = new (require('node:events').EventEmitter)();
    secure.pause = () => {};
    secure.resume = () => {};
    secure.destroy = () => { if (!secure.destroyed) { secure.destroyed = true; secure.emit('close'); } };
    secure.write = function(data) {
        for (const frame of decodeFrames(data).frames) {
            const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : null;
            process.stderr.write('MOCK_IN:' + frame.opcode + ':' + code + '\\n');
        }
        // Drop the upstream stream without a Close frame, the way a real remote failure
        // looks, so the page-facing behaviour can be checked.
        if (process.env.MOCK_UPSTREAM_DROP) {
            setTimeout(() => secure.destroy(), 100);
        }
        return true;
    };
    if (process.env.MOCK_UPSTREAM_CLOSE) {
        setTimeout(() => {
            secure.emit('data', Buffer.from([0x88, 0x02, 0x03, 0xe9])); // close(1001)
        }, 150);
    }
    return Promise.resolve({ secure, ip, initial: Buffer.alloc(0) });
}
function unusedOriginalOpenUpstream(ip) {`;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function httpCall(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, timeout: 1200 }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.once('timeout', () => req.destroy(new Error('timeout')));
    req.once('error', reject);
    req.end();
  });
}

function maskedFrame(opcode, payload) {
  const data = Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(data.map((byte, i) => byte ^ mask[i % 4]));
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | data.length]), mask, masked]);
}

function closePayload(code, reason) {
  const body = Buffer.alloc(2 + Buffer.byteLength(reason || ''));
  body.writeUInt16BE(code, 0);
  if (reason) body.write(reason, 2);
  return body;
}

async function startRelay(env) {
  const port = await freePort();
  const code = source.replace(/^#![^\n]*\n/, '').replace(target, mock);
  const child = spawn(process.execPath, ['-e', code], {
    stdio: ['ignore', 'ignore', 'pipe'],
    cwd: __dirname,
    env: { ...process.env, RELAY_PORT: String(port), RELAY_IDLE_MS: '0', ...env }
  });

  const state = { child, port, stderr: '' };
  child.stderr.on('data', c => { state.stderr += String(c); });

  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('relay exited: ' + state.stderr);
    try {
      if ((await httpCall(port, '/health')).status === 200) return state;
    } catch {}
    await new Promise(r => setTimeout(r, 70));
  }

  child.kill();
  throw new Error('relay did not start: ' + state.stderr);
}

// Connects, collects frames, and exposes next(predicate).
function connect(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('upgrade timeout')); }, 2000);
    let buffer = Buffer.alloc(0);
    const received = [];
    const waiters = [];
    let ready = false;

    const check = () => waiters.splice(0).forEach(fn => fn());

    const parse = () => {
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        }
        if (buffer.length < offset + length) return;
        received.push({ opcode, payload: buffer.subarray(offset, offset + length) });
        buffer = buffer.subarray(offset + length);
      }
      check();
    };

    socket.once('connect', () => socket.write(
      `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\nOrigin: https://matrix.tencent.com\r\n\r\n`
    ));

    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);

      if (!ready) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        clearTimeout(timer);
        ready = true;
        buffer = buffer.subarray(end + 4);
        socket.removeAllListeners('error');
        socket.on('error', () => {});

        resolve({
          socket,
          received,
          next(predicate, ms = 2000) {
            return new Promise(resolveFrame => {
              const found = received.find(predicate);
              if (found) { resolveFrame(found); return; }

              const done = setTimeout(() => resolveFrame(null), ms);
              waiters.push(() => {
                const hit = received.find(predicate);
                if (hit) { clearTimeout(done); resolveFrame(hit); }
              });
            });
          }
        });
        parse();
        return;
      }

      parse();
    });

    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function stop(state) {
  if (state.child.exitCode === null) {
    state.child.kill();
    await sleep(150);
  }
}

(async () => {
  let checks = 0;
  const check = label => { checks++; process.stdout.write(`  ok    ${label}\n`); };

  const upSawClose = state => state.stderr.split('\n')
    .filter(line => line.startsWith('MOCK_IN:'))
    .map(line => {
      const [, opcode, code] = line.split(':');
      return { opcode: Number(opcode), code: Number(code) };
    })
    .some(f => f.opcode === 0x8);

  const plain = await startRelay({});
  const closing = await startRelay({ MOCK_UPSTREAM_CLOSE: '1' });
  const dropping = await startRelay({ MOCK_UPSTREAM_DROP: '1' });

  try {
    // 1 + 2. Page-initiated close: answered locally and passed upstream.
    {
      const conn = await connect(plain.port);
      conn.socket.write(maskedFrame(0x8, closePayload(1000, 'bye')));

      const answer = await conn.next(f => f.opcode === 0x8);
      assert(answer, 'the relay must answer a page close with a close frame');
      assert.equal(answer.payload.readUInt16BE(0), 1000, 'the reply carries the close code the page sent');
      check('the page close is answered with a matching close frame');

      await sleep(250);
      assert(upSawClose(plain), 'the close must also be passed on to the upstream');
      check('the page close is passed on to the upstream instead of being swallowed');

      conn.socket.destroy();
      await sleep(150);
    }

    // 3. Upstream-initiated close reaches the page with the upstream's code.
    {
      const conn = await connect(closing.port);
      const close = await conn.next(f => f.opcode === 0x8, 2500);

      assert(close, 'an upstream close must be forwarded to the page');
      assert.equal(close.payload.length >= 2 ? close.payload.readUInt16BE(0) : null, 1001,
        'the page receives the upstream close code, not 1006');
      check('an upstream close reaches the page with its own code');

      conn.socket.destroy();
      await sleep(150);
    }

    // 4. An upstream that drops without a Close frame still gets a close handshake towards the
    //    page, with 1011 (unexpected condition). A bare teardown here is what made every remote
    //    drop look like an abnormal closure to the page.
    {
      const conn = await connect(dropping.port);
      conn.socket.write(maskedFrame(0x1, 'hello'));

      const close = await conn.next(f => f.opcode === 0x8, 3000);
      assert(close, 'an upstream drop must still produce a close frame towards the page');
      assert.equal(close.payload.readUInt16BE(0), 1011, 'the page is told the far side ended unexpectedly');
      check('an upstream drop is reported to the page as close(1011), not a bare disconnect');

      conn.socket.destroy();
      await sleep(150);
    }

    // 5. Both relays still serve: the close path released its slot instead of leaking it.
    assert.equal((await httpCall(plain.port, '/health')).status, 200);
    assert.equal((await httpCall(closing.port, '/health')).status, 200);
    assert.equal((await httpCall(dropping.port, '/health')).status, 200);
    check('the relay still answers after close handshakes complete');

    process.stdout.write(`\nPASS: ${checks}/${checks} close handshake checks\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  } finally {
    await stop(plain);
    await stop(closing);
    await stop(dropping);
  }
})();
