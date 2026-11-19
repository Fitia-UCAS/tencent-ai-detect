// The quick-pass regression: short tickets must leave the shim, remain pending for diagnostics,
// and only a later full ticket may clear the pending marker. No browser or relay is required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Event, EventTarget, MessageEvent, CustomEvent, DOMException } = globalThis;

class FakeWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances = [];

    constructor(url) {
        super();
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
        this.sent = [];
        this.sendCalls = [];
        FakeWebSocket.instances.push(this);
    }

    open() {
        this.readyState = FakeWebSocket.OPEN;
        if (typeof this.onopen === 'function') this.onopen(new Event('open'));
    }

    send(data) {
        this.sendCalls.push(data);
        if (this.readyState === FakeWebSocket.OPEN) this.sent.push(data);
    }

    close() {
        this.readyState = FakeWebSocket.CLOSING;
    }
}

const attributes = new Map();
const storage = new Map();
const window = new EventTarget();
Object.assign(window, {
    WebSocket: FakeWebSocket,
    EventTarget,
    URL,
    DOMException,
    location: { href: 'https://matrix.tencent.com/ai-detect/' },
    document: {
        documentElement: {
            getAttribute: key => attributes.get(key) || null,
            setAttribute: (key, value) => attributes.set(key, String(value))
        }
    },
    sessionStorage: {
        getItem: key => storage.get(key) || null,
        setItem: (key, value) => storage.set(key, String(value))
    },
    localStorage: { getItem: () => null }
});

const context = vm.createContext({
    window,
    EventTarget,
    Event,
    MessageEvent,
    CustomEvent,
    CloseEvent: Event,
    DOMException,
    URL,
    setTimeout,
    clearTimeout,
    console
});

const shimPath = path.join(__dirname, '..', '..', 'src', 'shim', 'index.js');
vm.runInContext(fs.readFileSync(shimPath, 'utf8'), context, { filename: 'src/shim/index.js' });

const TARGET_URL = 'wss://matrix.tencent.com/ai_gen_txt_server/getClassify';
const socket = new window.WebSocket(TARGET_URL);
const relay = FakeWebSocket.instances[0];
assert.ok(relay, 'the detection socket must be routed through the fake relay');
relay.open();

const quickPassEvents = [];
const clearedAtSendCount = [];
const sentTrace = [];
window.addEventListener('zq:quick-pass', event => quickPassEvents.push(event.detail));
window.addEventListener('zq:quick-pass-cleared', () => clearedAtSendCount.push(relay.sendCalls.length));
window.addEventListener('zq:relay-sent', event => sentTrace.push(event.detail));

const shortFrame = JSON.stringify({ ticket: 'x'.repeat(170) });
const secondShortFrame = JSON.stringify({ ticket: 'y'.repeat(130) });
const fullFrame = JSON.stringify({ ticket: 'z'.repeat(214) });

// This is the critical anti-deadlock assertion: a short ticket still calls the underlying socket's
// send() with the exact original frame. Merely removing the panel would not prove this.
socket.send(shortFrame);
assert.deepEqual(relay.sendCalls, [shortFrame], 'the short ticket must call _sock.send() exactly once');
assert.deepEqual(relay.sent, [shortFrame], 'the short ticket must leave the shim');
assert.equal(quickPassEvents.length, 1);
assert.equal(quickPassEvents[0].ticketLength, 170);
assert.equal(quickPassEvents[0].frame, shortFrame, 'the full short-ticket frame must be retained for the trail');
assert.deepEqual(sentTrace, [shortFrame], 'the outbound trail must include the short ticket');
assert.deepEqual(clearedAtSendCount, [], 'a short ticket must not announce recovery');

socket.send(secondShortFrame);
assert.deepEqual(relay.sent, [shortFrame, secondShortFrame]);
assert.equal(quickPassEvents.length, 2);
assert.deepEqual(clearedAtSendCount, [], 'another short ticket must leave recovery pending');

socket.send(fullFrame);
assert.deepEqual(relay.sent, [shortFrame, secondShortFrame, fullFrame]);
assert.deepEqual(clearedAtSendCount, [3], 'recovery may clear only after the full ticket has been sent');

socket.send(fullFrame);
assert.deepEqual(relay.sent, [shortFrame, secondShortFrame, fullFrame, fullFrame]);
assert.deepEqual(clearedAtSendCount, [3], 'the same pending marker must clear only once');

process.stdout.write('PASS: short tickets are sent, traced, and do not clear recovery until a full ticket is sent\n');
