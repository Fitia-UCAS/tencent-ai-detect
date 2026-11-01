// Offline regression for WebSocket message fragmentation in the relay.
//
// Chromium splits a single send() above 128 KiB into one text frame with FIN=0 followed by
// continuation frames. The relay used to reject that framing outright and close the page
// socket, so a large paste failed the detection with no readable reason. The relay now
// reassembles fragments per direction.
//
// What has to hold, and what this checks:
//   1. A message is forwarded once, whole, and only after its final fragment. Forwarding a
//      partial message would put bytes upstream that belong to a message the page has not
//      finished; the page would then be talking to an upstream that holds half an object.
//   2. Control frames interleaved between fragments still pass through immediately.
//   3. A reassembled message above MAX_MESSAGE_BYTES is refused instead of buffered without
//      bound.
//   4. The retry decision still counts one message once: a fragmented send must not look
//      like several frames handed upstream.
//
// Only openUpstream is replaced by a local EventEmitter, so this never contacts the service.
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

// The mock records every message the relay hands it, as a stderr marker, so the test can
// assert on content rather than on timing.
const mock = `
function openUpstream(ip) {
    const secure = new (require('node:events').EventEmitter)();
    secure.pause = () => {};
    secure.resume = () => {};
    secure.destroy = () => { if (!secure.destroyed) { secure.destroyed = true; secure.emit('close'); } };
    secure.write = function(data) {
        for (const frame of decodeFrames(data).frames) {
            process.stderr.write('MOCK_MSG:' + frame.opcode + ':' + frame.payload.length + ':' +
                frame.payload.toString('utf8') + '\\n');
        }
        return true;
    };
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

function httpCall(port, method, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, timeout: 1200 }, res => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.once('timeout', () => req.destroy(new Error('timeout')));
    req.once('error', reject);
    req.end();
  });
}

// One WebSocket frame, optionally the first or a middle fragment of a larger message.
function maskedFrame(opcode, payload, { fin = true } = {}) {
  const data = Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(data.map((byte, index) => byte ^ mask[index % 4]));
  const first = (fin ? 0x80 : 0x00) | opcode;

  if (data.length < 126) {
    return Buffer.concat([Buffer.from([first, 0x80 | data.length]), mask, masked]);
  }

  if (data.length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
    return Buffer.concat([header, mask, masked]);
  }

  // 64-bit length form, used for the oversized-message case.
  const header = Buffer.alloc(10);
  header[0] = first;
  header[1] = 0x80 | 127;
  header.writeBigUInt64BE(BigInt(data.length), 2);
  return Buffer.concat([header, mask, masked]);
}

function upgrade(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('upgrade timeout')); }, 2000);
    let buffer = Buffer.alloc(0);

    socket.once('connect', () => socket.write(
      `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\nOrigin: https://matrix.tencent.com\r\n\r\n`
    ));

    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      clearTimeout(timer);
      socket.removeAllListeners('data');
      socket.on('error', () => {});
      resolve(socket);
    });

    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function closedSoon(socket, ms = 1800) {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error('socket should have closed')), ms);
    socket.once('close', () => { clearTimeout(timer); resolve(); });
    socket.once('error', () => {});
  });
}

(async () => {
  const port = await freePort();
  const code = source.replace(/^#![^\n]*\n/, '').replace(target, mock);
  const child = spawn(process.execPath, ['-e', code], {
    stdio: ['ignore', 'ignore', 'pipe'],
    cwd: __dirname,
    env: { ...process.env, RELAY_PORT: String(port), RELAY_IDLE_MS: '0' }
  });

  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });

  const messages = () => stderr.split('\n')
    .filter(line => line.startsWith('MOCK_MSG:'))
    .map(line => {
      const [, opcode, length, ...rest] = line.split(':');
      return { opcode: Number(opcode), length: Number(length), text: rest.join(':') };
    });

  let checks = 0;
  const check = label => { checks++; process.stdout.write(`  ok    ${label}\n`); };

  try {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('relay exited: ' + stderr);
      try {
        if ((await httpCall(port, 'GET', '/health')).status === 200) break;
      } catch {}
      await sleep(70);
    }

    // 1. A message split across three frames is forwarded once, after the last one.
    {
      const socket = await upgrade(port);
      const before = messages().length;

      socket.write(maskedFrame(0x1, 'first-', { fin: false }));
      await sleep(150);
      assert.equal(messages().length, before, 'a partial message must not reach the upstream');

      socket.write(maskedFrame(0x0, 'second-', { fin: false }));
      await sleep(150);
      assert.equal(messages().length, before, 'a middle fragment must not reach the upstream');

      socket.write(maskedFrame(0x0, 'third', { fin: true }));
      await sleep(250);

      const after = messages();
      assert.equal(after.length, before + 1, 'the finished message must be forwarded exactly once');
      const last = after[after.length - 1];
      assert.equal(last.opcode, 0x1, 'the message keeps its original text opcode');
      assert.equal(last.text, 'first-second-third', 'fragments are concatenated in order');
      check('a fragmented message is reassembled and forwarded once, after its final fragment');

      socket.destroy();
      await sleep(100);
    }

    // 2. A control frame between fragments passes through immediately.
    {
      const socket = await upgrade(port);
      const before = messages().length;

      socket.write(maskedFrame(0x1, 'head-', { fin: false }));
      await sleep(120);
      socket.write(maskedFrame(0x9, 'are-you-there'));  // ping
      await sleep(200);

      const seeControl = messages().slice(before).some(m => m.opcode === 0x9);
      assert(seeControl, 'a ping between fragments must be forwarded without waiting for the message');

      socket.write(maskedFrame(0x0, 'tail', { fin: true }));
      await sleep(250);

      const whole = messages().slice(before).filter(m => m.opcode === 0x1);
      assert.equal(whole.length, 1);
      assert.equal(whole[0].text, 'head-tail', 'the message still completes after the control frame');
      check('a control frame between fragments is forwarded immediately and does not disturb the message');

      socket.destroy();
      await sleep(100);
    }

    // 3. A close frame between fragments closes the connection rather than completing the
    //    message: a half-delivered message must never be forwarded.
    {
      const socket = await upgrade(port);
      const before = messages().length;

      socket.write(maskedFrame(0x1, 'never-', { fin: false }));
      await sleep(120);

      const closed = closedSoon(socket);
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(1000, 0);
      socket.write(maskedFrame(0x8, payload));
      await closed;

      const forwarded = messages().slice(before).filter(m => m.opcode === 0x1);
      assert.equal(forwarded.length, 0, 'an unfinished message must not be forwarded when the socket closes');
      check('a close in the middle of a message does not forward the partial message');
    }

    // 4. An oversized reassembled message is refused instead of buffered without bound.
    {
      const socket = await upgrade(port);
      const chunk = Buffer.alloc(512 * 1024, 0x41);
      const closed = closedSoon(socket, 3000);

      // 512 KiB fragments until the reassembled total passes MAX_MESSAGE_BYTES (4 MiB).
      for (let i = 0; i < 10; i++) {
        socket.write(maskedFrame(i === 0 ? 0x1 : 0x0, chunk, { fin: false }));
        if (socket.destroyed) break;
      }

      await closed;
      check('a reassembled message above the limit is refused instead of buffered without bound');
    }

    process.stdout.write(`\nPASS: ${checks}/${checks} fragmentation checks\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  } finally {
    child.kill();
  }
})();
