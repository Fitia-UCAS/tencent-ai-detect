// The bounded frame queue both directions of a relay connection use.
//
// Two directions used to carry their own copy of this logic, which is how they ended up with
// different state names and mismatched limits. These cases pin the properties the copies had to
// agree on: order is preserved, both limits are enforced, a refusing sink pauses the source and
// resumes it once drained, and a drain from a replaced sink does not resume the new one.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createFrameQueue } = require('../../src/relay/frame-queue.cjs');

const checks = [];
const check = (name, fn) => {
    try {
        fn();
        checks.push(true);
        console.log('  ok    ' + name);
    } catch (error) {
        checks.push(false);
        console.log('  FAIL  ' + name + ' — ' + error.message);
    }
};

// A sink that records every write and refuses once `acceptLimit` writes have been accepted.
function makeSink({ acceptLimit = Infinity } = {}) {
    const written = [];
    let accepted = 0;
    const sink = new EventEmitter();

    sink.write = buffer => {
        written.push(buffer.toString());
        if (accepted >= acceptLimit) return false;
        accepted += 1;
        return true;
    };
    sink.acceptEverything = () => {
        sink.write = buffer => { written.push(buffer.toString()); return true; };
    };
    sink.written = written;
    return sink;
}

const frame = text => ({ payload: Buffer.from(text), opcode: 0x1 });

function makeQueue(sink, overrides = {}) {
    const state = { paused: 0, resumed: 0, open: true, sink };
    const queue = createFrameQueue(Object.assign({
        maxFrames: 4,
        maxBytes: 64,
        encode: f => f.payload,
        currentSink: () => state.sink,
        isOpen: () => state.open,
        pauseSource: () => { state.paused += 1; },
        resumeSource: () => { state.resumed += 1; }
    }, overrides));
    return { queue, state };
}

check('frames leave in the order they were pushed', () => {
    const sink = makeSink();
    const { queue } = makeQueue(sink);

    for (const text of ['a', 'b', 'c']) queue.push(frame(text));
    assert.deepEqual(sink.written, ['a', 'b', 'c']);
});

check('a full queue refuses the next frame instead of growing', () => {
    // The sink refuses, so everything after the first attempt is held.
    const sink = makeSink({ acceptLimit: 0 });
    const { queue } = makeQueue(sink);

    const outcomes = [];
    for (let i = 1; i <= 6; i += 1) outcomes.push(queue.push(frame(String(i))));

    // The first push hands its frame straight to the sink, which refuses it; the limit then admits
    // exactly maxFrames more.
    assert.deepEqual(outcomes, [true, true, true, true, true, false],
        'the queue admits maxFrames frames while the sink is blocked');
});

check('the byte limit refuses a frame that would overflow it', () => {
    const sink = makeSink({ acceptLimit: 0 });
    const { queue } = makeQueue(sink, { maxFrames: 100, maxBytes: 10 });

    // Ten bytes fit; the eleventh does not. The first push is handed to the sink and refused, so the
    // bytes count only the frames that are actually held.
    assert.equal(queue.push(frame('12345')), true);
    assert.equal(queue.push(frame('12345')), true);
    assert.equal(queue.push(frame('12345')), true, 'two frames fill the ten-byte budget exactly');
    assert.equal(queue.push(frame('1')), false, 'an eleventh byte is over the limit');
});

check('a refusing sink pauses the source, and the drain resumes it', () => {
    const sink = makeSink({ acceptLimit: 1 });
    const { queue, state } = makeQueue(sink);

    queue.push(frame('a'));
    queue.push(frame('b'));

    assert.deepEqual(sink.written, ['a', 'b'], 'the second write was attempted');
    assert.equal(state.paused, 1, 'the source must stop being read while the sink is behind');

    const resumedBefore = state.resumed;
    sink.acceptEverything();
    sink.emit('drain');

    assert.equal(state.resumed > resumedBefore, true, 'the source is resumed once the sink caught up');
    assert.deepEqual(sink.written, ['a', 'b'], 'and the drain itself writes nothing new');
});

check('a drain from a replaced sink does not resume the new one', () => {
    const oldSink = makeSink({ acceptLimit: 1 });
    const { queue, state } = makeQueue(oldSink);

    queue.push(frame('a'));
    queue.push(frame('b'));
    assert.equal(state.paused, 1);

    // A retry swaps the upstream socket while the queue is still blocked on the old one.
    state.sink = makeSink();
    const resumedBefore = state.resumed;

    oldSink.emit('drain');
    assert.equal(state.resumed, resumedBefore, 'the stale drain must be ignored');
});

check('a closed connection is never written to', () => {
    const sink = makeSink();
    const { queue, state } = makeQueue(sink);

    state.open = false;
    queue.push(frame('a'));
    assert.deepEqual(sink.written, [], 'nothing may go out once the connection is closed');
});

check('a missing sink holds the queue instead of dropping it', () => {
    const sink = makeSink();
    const { queue, state } = makeQueue(sink);

    // This is the window during a retry: the frames belong to the connection and the new upstream
    // has not been established yet.
    state.sink = null;
    assert.equal(queue.push(frame('a')), true);

    const resumedBefore = state.resumed;
    state.sink = sink;
    queue.flush();

    assert.deepEqual(sink.written, ['a'], 'the held frame is written once a sink exists');
    assert.equal(state.resumed > resumedBefore, true, 'and the source resumes');
});

check('clearing drops what was queued', () => {
    const sink = makeSink({ acceptLimit: 0 });
    const { queue, state } = makeQueue(sink);

    queue.push(frame('a'));   // attempted, refused
    queue.push(frame('b'));   // queued
    queue.clear();

    sink.acceptEverything();
    sink.emit('drain');       // unblocks the queue
    queue.flush();

    assert.deepEqual(sink.written, ['a'],
        'the refused attempt stays in the sink log; the queued frame was dropped');
    assert.equal(state.resumed > 0, true, 'the queue is usable again after the drain');
});

const failed = checks.filter(ok => !ok).length;
console.log('');
if (failed) {
    console.error(`${failed}/${checks.length} frame queue checks failed`);
    process.exit(1);
}
console.log(`PASS: ${checks.length}/${checks.length} frame queue checks`);
