// Local, deterministic WebSocket/EventTarget conformance tests for shim.js.
// No browser, relay, or external website is required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Event, EventTarget, MessageEvent, DOMException } = globalThis;

class TestCloseEvent extends Event {
  constructor(type, init = {}) {
    super(type);
    this.code = init.code || 0;
    this.reason = init.reason || '';
    this.wasClean = !!init.wasClean;
  }
}

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];
  static throwOnUrl = null;

  constructor(url, protocols) {
    super();

    if (FakeWebSocket.throwOnUrl && url === FakeWebSocket.throwOnUrl) {
      throw new DOMException('simulated synchronous construction failure', 'SyntaxError');
    }

    if (protocols !== undefined) {
      const list = typeof protocols === 'string' ? [protocols] : Array.from(protocols);
      const seen = new Set();
      for (const protocol of list) {
        if (typeof protocol !== 'string' || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(protocol) || seen.has(protocol)) {
          throw new DOMException('invalid WebSocket subprotocol', 'SyntaxError');
        }
        seen.add(protocol);
      }
    }

    Object.defineProperty(this, 'url', { value: url, configurable: true, enumerable: true });
    for (const [name, value] of Object.entries({
      protocol: '', extensions: '', bufferedAmount: 0, binaryType: 'blob',
      readyState: FakeWebSocket.CONNECTING
    })) {
      Object.defineProperty(this, name, { value, writable: true, configurable: true, enumerable: true });
    }
    this.sent = [];
    this.closeArgs = null;
    FakeWebSocket.instances.push(this);
  }

  emit(type, event) {
    const handler = this['on' + type];
    if (typeof handler === 'function') handler.call(this, event || new Event(type));
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open', new Event('open'));
  }

  receive(data) {
    this.emit('message', new MessageEvent('message', {
      data,
      origin: 'wss://matrix.tencent.com',
      lastEventId: 'test-event'
    }));
  }

  fail() {
    this.emit('error', new Event('error'));
  }

  finishClose({ code = 1006, reason = '', wasClean = false } = {}) {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', new TestCloseEvent('close', { code, reason, wasClean }));
  }

  send(data) {
    if (this.readyState === FakeWebSocket.CONNECTING) {
      throw new DOMException('still connecting', 'InvalidStateError');
    }
    if (this.readyState !== FakeWebSocket.OPEN) return;
    this.sent.push(data);
  }

  close(...args) {
    const code = args[0];
    const reason = args[1];
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException('invalid close code', 'InvalidAccessError');
    }
    if (reason !== undefined && Buffer.byteLength(String(reason), 'utf8') > 123) {
      throw new DOMException('close reason is too long', 'SyntaxError');
    }
    this.closeArgs = args;
    this.readyState = FakeWebSocket.CLOSING;
  }
}

const window = {
  WebSocket: FakeWebSocket,
  EventTarget,
  URL,
  DOMException,
  location: { href: 'https://matrix.tencent.com/ai-detect/' }
};

const context = vm.createContext({
  window,
  EventTarget,
  Event,
  MessageEvent,
  CloseEvent: TestCloseEvent,
  DOMException,
  URL,
  setTimeout,
  clearTimeout,
  console
});

const shimPath = path.join(__dirname, '..', '..', 'src', 'shim', 'index.js');
vm.runInContext(fs.readFileSync(shimPath, 'utf8'), context, { filename: 'src/shim/index.js' });
const WebSocketShim = window.WebSocket;
const TARGET_URL = 'wss://matrix.tencent.com/ai_gen_txt_server/getClassify';
const results = [];
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function resetFake() {
  FakeWebSocket.instances.length = 0;
  FakeWebSocket.throwOnUrl = null;
}

function latestSocket() {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

test('wrapper remains an EventTarget and a WebSocket instance', () => {
  resetFake();
  const socket = new WebSocketShim('wss://example.com/ordinary');
  assert.equal(socket instanceof EventTarget, true);
  assert.equal(socket instanceof FakeWebSocket, true);
  assert.equal(socket instanceof WebSocketShim, true);
  assert.equal(WebSocketShim.CONNECTING, FakeWebSocket.CONNECTING);
  assert.equal(socket.url, 'wss://example.com/ordinary');
});

test('native URL validation remains synchronous', () => {
  resetFake();
  const before = FakeWebSocket.instances.length;
  assert.throws(
    () => new WebSocketShim('https://matrix.tencent.com/ai_gen_txt_server/getClassify'),
    error => error && error.name === 'SyntaxError'
  );
  assert.equal(FakeWebSocket.instances.length, before);
  assert.throws(
    () => new WebSocketShim('wss://matrix.tencent.com/ai_gen_txt_server/getClassify', ['bad protocol']),
    error => error && error.name === 'SyntaxError'
  );
});

test('EventTarget listeners receive wrapper-targeted open and message events', () => {
  resetFake();
  const socket = new WebSocketShim(TARGET_URL);
  const relay = latestSocket();
  const observed = [];
  socket.addEventListener('open', event => observed.push(['open', event.target, event.currentTarget]));
  socket.addEventListener('message', event => observed.push(['message', event.target, event.currentTarget, event.data]));

  relay.open();
  relay.receive('hello');

  assert.equal(observed.length, 2);
  assert.equal(observed[0][0], 'open');
  assert.equal(observed[0][1], socket);
  assert.equal(observed[0][2], socket);
  assert.equal(observed[1][0], 'message');
  assert.equal(observed[1][1], socket);
  assert.equal(observed[1][2], socket);
  assert.equal(observed[1][3], 'hello');
});

test('onmessage property handler uses the wrapper as this and event target', () => {
  resetFake();
  const socket = new WebSocketShim('wss://example.com/ordinary');
  const native = latestSocket();
  let seen = false;
  socket.onmessage = function(event) {
    seen = this === socket && event.target === socket && event.data === 'payload';
  };
  native.open();
  native.receive('payload');
  assert.equal(seen, true);
});

test('object listeners and once semantics follow EventTarget', () => {
  resetFake();
  const socket = new WebSocketShim('wss://example.com/ordinary');
  const native = latestSocket();
  let objectCalls = 0;
  let onceCalls = 0;
  const objectListener = {
    handleEvent(event) {
      assert.equal(this, objectListener);
      assert.equal(event.target, socket);
      objectCalls++;
    }
  };
  socket.addEventListener('message', objectListener);
  socket.addEventListener('message', () => onceCalls++, { once: true });
  native.open();
  native.receive('one');
  native.receive('two');
  assert.equal(objectCalls, 2);
  assert.equal(onceCalls, 1);
});

test('removeEventListener distinguishes capture registrations', () => {
  resetFake();
  const socket = new WebSocketShim('wss://example.com/ordinary');
  const native = latestSocket();
  let calls = 0;
  const listener = () => calls++;
  socket.addEventListener('message', listener, false);
  socket.addEventListener('message', listener, true);
  socket.removeEventListener('message', listener, true);
  native.open();
  native.receive('one');
  assert.equal(calls, 1);
});

test('relay failure stays invisible and falls back without replaying frames', () => {
  resetFake();
  const socket = new WebSocketShim(TARGET_URL);
  const relay = latestSocket();
  let errors = 0;
  let closes = 0;
  let opens = 0;
  socket.addEventListener('error', () => errors++);
  socket.addEventListener('close', () => closes++);
  socket.addEventListener('open', () => opens++);
  socket.binaryType = 'arraybuffer';

  relay.fail();
  assert.equal(FakeWebSocket.instances.length, 2);
  const direct = latestSocket();
  assert.equal(direct.url, TARGET_URL);
  assert.equal(direct.binaryType, 'arraybuffer');
  assert.equal(errors, 0);
  assert.equal(closes, 0);

  direct.open();
  assert.equal(opens, 1);
  assert.equal(socket.readyState, WebSocketShim.OPEN);
});

test('fallback construction failure dispatches one error and one close; no late replay', async () => {
  resetFake();
  FakeWebSocket.throwOnUrl = TARGET_URL;
  const socket = new WebSocketShim(TARGET_URL);
  let errors = 0;
  let closes = 0;
  const order = [];
  socket.addEventListener('error', event => {
    assert.equal(event.target, socket);
    errors++;
    order.push('error');
    socket.addEventListener('close', () => order.push('close-added-during-error'));
  });
  socket.addEventListener('close', event => {
    assert.equal(event.target, socket);
    assert.equal(event.code, 1006);
    closes++;
    order.push('close');
  });

  latestSocket().fail();
  assert.equal(socket.readyState, WebSocketShim.CLOSED);

  // The terminal event task is queued. A listener attached before it runs must
  // observe the event; one attached after it has run must not get a replay.
  let lateButInTime = 0;
  socket.addEventListener('error', () => lateButInTime++);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(errors, 1);
  assert.equal(closes, 1);
  assert.equal(lateButInTime, 1);
  assert.deepEqual(order, ['error', 'close', 'close-added-during-error']);

  let lateErrors = 0;
  let lateCloses = 0;
  socket.addEventListener('error', () => lateErrors++);
  socket.addEventListener('close', () => lateCloses++);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(lateErrors, 0);
  assert.equal(lateCloses, 0);
});

// Deliberate divergence from the native contract, and only for the detection
// socket: a frame sent while CONNECTING is held and delivered on open instead of
// throwing InvalidStateError.
//
// The page sends its handshake frame from the open handler of whichever socket
// opened, but reads `this.websock`, and it overwrites that field when it
// re-initialises while a connection is still in progress. Native throws, which
// the page did not catch: it surfaced as an uncaught InvalidStateError and the
// handshake frame was lost. See the stale-handler case below.
test('send while connecting is queued and delivered on open, not thrown', () => {
  resetFake();
  const socket = new WebSocketShim(TARGET_URL);
  const native = latestSocket();
  assert.doesNotThrow(() => socket.send('too early'));
  assert.deepEqual(native.sent, []);
  native.open();
  assert.deepEqual(native.sent, ['too early']);
  socket.send('ready');
  assert.deepEqual(native.sent, ['too early', 'ready']);
  socket.close();
  assert.equal(native.readyState, FakeWebSocket.CLOSING);
  assert.doesNotThrow(() => socket.send('after close requested'));
});

// Every other WebSocket on the page must keep the native contract exactly, since
// only the detection socket is rerouted. Queuing here would silently change the
// timing of unrelated code.
test('a non-target socket keeps the native CONNECTING throw', () => {
  resetFake();
  const socket = new WebSocketShim('wss://example.com/ordinary');
  const native = latestSocket();

  assert.throws(
    () => socket.send('too early'),
    error => error.name === 'InvalidStateError'
  );
  assert.deepEqual(native.sent, []);

  native.open();
  socket.send('ready');
  assert.deepEqual(native.sent, ['ready']);
});

// The page-side race: socket A opens and its handler sends on `this.websock`,
// which by then points at socket B that is still connecting. Before the queuing
// change that threw and the frame was lost.
//
// Both sends go out. The page called send() twice, so two frames are correct and
// match what the native API does; silently merging them (an earlier version did
// exactly that) would leave a retried request waiting for a reply the server was
// never asked for.
test('a stale open handler sending into a connecting socket delivers every send', () => {
  resetFake();
  const first = new WebSocketShim(TARGET_URL);
  const socketA = latestSocket();
  const second = new WebSocketShim(TARGET_URL);
  const socketB = latestSocket();

  // A opens first; the page's handler reads the newer socket B.
  socketA.open();
  assert.doesNotThrow(() => second.send(JSON.stringify({ fp: 'handshake' })));

  // B opens and flushes it, then its own open handler sends the same frame again.
  socketB.open();
  second.send(JSON.stringify({ fp: 'handshake' }));

  assert.deepEqual(socketB.sent.map(String), [
    JSON.stringify({ fp: 'handshake' }),
    JSON.stringify({ fp: 'handshake' })
  ]);
  assert.equal(first.readyState, 1);
});

test('closing a connecting relay does not start an unsolicited fallback', () => {
  resetFake();
  const socket = new WebSocketShim(TARGET_URL);
  const relay = latestSocket();
  let closes = 0;
  socket.addEventListener('close', () => closes++);
  socket.close();
  relay.finishClose({ code: 1000, reason: '', wasClean: true });
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(closes, 1);
});

test('native close validation errors are preserved and do not suppress fallback', () => {
  resetFake();
  const socket = new WebSocketShim(TARGET_URL);
  const relay = latestSocket();
  assert.throws(() => socket.close(1001), error => error.name === 'InvalidAccessError');
  assert.throws(() => socket.close(3000, 'x'.repeat(124)), error => error.name === 'SyntaxError');
  relay.fail();
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(latestSocket().url, TARGET_URL);
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      results.push({ name, ok: true });
      process.stdout.write(`  ok    ${name}\n`);
    } catch (error) {
      results.push({ name, ok: false, error });
      process.stdout.write(`  FAIL  ${name}: ${error.stack || error}\n`);
    }
  }

  const failed = results.filter(result => !result.ok);
  if (failed.length) {
    process.stderr.write(`\n${failed.length}/${results.length} shim semantic checks failed\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`\nPASS: ${results.length}/${results.length} shim semantic checks\n`);
  }
})();
