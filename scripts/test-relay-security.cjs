// Offline security regression for the actual Relay code with ONLY openUpstream
// replaced by a local EventEmitter. Never contacts the third-party service.
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
const token = crypto.randomBytes(32).toString('hex');

const fakeUpstream = `
function openUpstream(ip) {
    const secure = new (require('node:events').EventEmitter)();
    let firstWrite = true;
    secure.write = function(_data) {
        setImmediate(() => secure.emit('data', Buffer.from([0x81, 0x02, 0x4f, 0x4b])));
        if (firstWrite) {
            firstWrite = false;
            setTimeout(() => secure.emit('drain'), 80);
            return false; // exercise source pause/resume on remote backpressure
        }
        return true;
    };
    secure.pause = () => {};
    secure.resume = () => {};
    secure.destroy = () => { secure.emit('close'); };
    return Promise.resolve({ secure, ip, initial: Buffer.alloc(0) });
}
function unusedOriginalUpstream(ip) {`;
const pendingUpstream = `
function openUpstream(ip) { return new Promise(() => {}); }
function unusedOriginalUpstream(ip) {`;

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
function httpCall(port, method, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers, timeout: 1200 }, res => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.once('timeout', () => req.destroy(new Error('timeout')));
    req.once('error', reject);
    req.end();
  });
}
async function startMockRelay(mockSource, idleMs = '0') {
  const port = await freePort();
  const code = source.replace(/^#![^\n]*\n/, '').replace(target, mockSource);
  const child = spawn(process.execPath, ['-e', code], {
    stdio: ['ignore', 'ignore', 'pipe'],
    cwd: __dirname,
    env: { ...process.env, RELAY_PORT: String(port), RELAY_IDLE_MS: idleMs, RELAY_HEARTBEAT_TOKEN: token }
  });
  let stderr = '';
  child.stderr.on('data', c => (stderr += String(c)));
  const until = Date.now() + 4000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error('mock relay exited: ' + stderr);
    try {
      const res = await httpCall(port, 'GET', '/health');
      if (res.status === 200) return { child, port };
    } catch {}
    await new Promise(r => setTimeout(r, 70));
  }
  child.kill();
  throw new Error('mock relay did not start: ' + stderr);
}
function upgrade(port, origin, pathname = '/ws') {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    const originHeader = origin === undefined ? '' : `Origin: ${origin}\r\n`;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('upgrade timeout')); }, 2000);
    let data = Buffer.alloc(0);
    socket.once('connect', () => socket.write(
      `GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
      `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n${originHeader}\r\n`
    ));
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]);
      const idx = data.indexOf('\r\n\r\n');
      if (idx < 0) return;
      clearTimeout(timer);
      const head = data.subarray(0, idx).toString('utf8');
      socket.removeAllListeners('data');
      resolve({ status: Number(head.match(/^HTTP\/1\.1 (\d+)/)[1]), socket, remainder: data.subarray(idx + 4) });
    });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.once('close', () => clearTimeout(timer));
  });
}
function maskedText(text) {
  const data = Buffer.from(text);
  assert(data.length < 126);
  const mask = crypto.randomBytes(4);
  return Buffer.concat([
    Buffer.from([0x81, 0x80 | data.length]), mask,
    Buffer.from(data.map((byte, index) => byte ^ mask[index % 4]))
  ]);
}
function closedSoon(socket) {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error('socket should have closed')), 1800);
    socket.once('close', () => { clearTimeout(timer); resolve(); });
    socket.once('error', () => {});
  });
}
async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise(resolve => {
    child.once('exit', resolve);
    setTimeout(resolve, 1000).unref();
  });
}

(async () => {
  let checks = 0;
  const owned = [];
  const sockets = [];
  const check = (label) => { checks++; console.log('ok', checks, label); };
  try {
    const a = await startMockRelay(fakeUpstream);
    owned.push(a.child);
    const health = await httpCall(a.port, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.headers['access-control-allow-origin'], undefined);
    assert.deepEqual(JSON.parse(health.body), {
      ok: true,
      service: 'zq-local-relay-v1'
    });
    check('GET health is read-only, minimal and without CORS wildcard');

    assert.equal((await httpCall(a.port, 'POST', '/keepalive')).status, 403);
    assert.equal((await httpCall(a.port, 'POST', '/keepalive', { 'x-relay-heartbeat-token': 'incorrect' })).status, 403);
    assert.equal((await httpCall(a.port, 'POST', '/keepalive', { 'x-relay-heartbeat-token': token })).status, 204);
    check('unauthorized heartbeats denied; owned token accepted');

    for (const [origin, pathname] of [
      ['https://evil.example.com', '/ws'], ['null', '/ws'], [undefined, '/ws'],
      ['https://matrix.tencent.com', '/anything-else']
    ]) {
      const res = await upgrade(a.port, origin, pathname);
      assert.equal(res.status, 403);
      res.socket.destroy();
    }
    check('foreign, null, missing Origin and wrong path all rejected');

    const legal = await upgrade(a.port, 'https://matrix.tencent.com');
    assert.equal(legal.status, 101);
    sockets.push(legal.socket);
    check('legitimate local WebSocket upgrade accepted');

    const frameResponse = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('mock upstream echo timeout')), 1500);
      let replies = 0;
      legal.socket.on('data', chunk => {
        replies += chunk.toString('latin1').split('OK').length - 1;
        if (replies >= 2) { clearTimeout(timer); resolve(); }
      });
    });
    legal.socket.write(maskedText('hello'));
    legal.socket.write(maskedText('again'));
    await frameResponse;
    check('two-way framing and upstream drain backpressure work with mock upstream');

    for (let i = 0; i < 15; i++) {
      const res = await upgrade(a.port, 'https://matrix.tencent.com');
      assert.equal(res.status, 101);
      sockets.push(res.socket);
    }
    const over = await upgrade(a.port, 'https://matrix.tencent.com');
    assert.equal(over.status, 503);
    over.socket.destroy();
    check('17th concurrent connection rejected after 16 active connections');

    const victim = sockets.pop();
    const released = closedSoon(victim);
    victim.write(Buffer.from([0x88, 0x80, 1, 2, 3, 4]));
    await released;
    await new Promise(r => setTimeout(r, 50));
    const reentry = await upgrade(a.port, 'https://matrix.tencent.com');
    assert.equal(reentry.status, 101);
    sockets.push(reentry.socket);
    check('released connection slot is reusable');

    await Promise.all(sockets.splice(0).map(async sock => {
      const ended = closedSoon(sock);
      sock.write(Buffer.from([0x88, 0x80, 1, 2, 3, 4]));
      await ended;
    }));
    await new Promise(r => setTimeout(r, 60));

    const huge = await upgrade(a.port, 'https://matrix.tencent.com');
    assert.equal(huge.status, 101);
    const header = Buffer.alloc(14);
    header[0] = 0x81; header[1] = 0xff;
    header.writeBigUInt64BE(64n * 1024n * 1024n, 2);
    crypto.randomFillSync(header, 10);
    const hugeClosed = closedSoon(huge.socket);
    huge.socket.write(header);
    await hugeClosed;
    check('64 MiB declared frame rejected before receiving payload');

    const reserved = await upgrade(a.port, 'https://matrix.tencent.com');
    assert.equal(reserved.status, 101);
    const reservedClosed = closedSoon(reserved.socket);
    // RSV1 set: nothing here negotiates an extension, so this must be refused.
    // Fragmented messages are now reassembled instead of refused; that path is
    // covered by test-relay-fragment.cjs.
    reserved.socket.write(Buffer.from([0xc1, 0x80, 1, 2, 3, 4]));
    await reservedClosed;
    check('reserved-bit frame closed rather than accepted');

    const p = await startMockRelay(pendingUpstream);
    owned.push(p.child);
    // No upstream 101; raw TCP frames are deliberately sent after upgrade request
    // to exercise the pre-upstream bounded queue (not a browser WebSocket test).
    const pendingSock = net.connect(p.port, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    pendingSock.on('error', () => {});
    await new Promise(resolve => pendingSock.once('connect', resolve));
    pendingSock.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${p.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: https://matrix.tencent.com\r\n\r\n`);
    await new Promise(resolve => setTimeout(resolve, 120));
    const pendingClosed = closedSoon(pendingSock);
    for (let i = 0; i < 40; i++) pendingSock.write(maskedText('a'));
    await pendingClosed;
    check('pre-upstream pending queue bounded to 32 frames');

    assert.equal((await httpCall(a.port, 'GET', '/health')).status, 200);
    check('relay remains responsive after rejected inputs');

    const idle = await startMockRelay(pendingUpstream, '250');
    owned.push(idle.child);
    const pollUntil = Date.now() + 6500;
    while (Date.now() < pollUntil && idle.child.exitCode === null) {
      try { await httpCall(idle.port, 'GET', '/health'); } catch {}
      await new Promise(r => setTimeout(r, 80));
    }
    assert.equal(idle.child.exitCode, 0, 'GET /health must not prolong the idle lease');
    check('repeated read-only health checks cannot prevent idle exit');
    console.log(`PASS: ${checks}/${checks} offline Relay security checks`);
  } finally {
    for (const s of sockets) s.destroy();
    for (const c of owned) await stop(c);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
