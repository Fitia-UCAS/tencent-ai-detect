// A bounded frame queue with backpressure, used for both directions of a connection.
//
// Both directions do the same thing: hold frames in order, write them to a stream, and when that
// stream reports its buffer full, stop reading from the other side until it drains. Writing that
// once means the two directions cannot drift apart in their limits, their drain handling, or their
// idea of what "blocked" means.

function createFrameQueue({
    maxFrames,
    maxBytes,
    encode,
    currentSink,
    isOpen,
    pauseSource,
    resumeSource
}) {
    const frames = [];
    let bytes = 0;
    let blocked = false;

    // Writes what is queued until the sink refuses or the queue empties. On refusal the source side is
    // paused so the queue cannot grow while the sink is behind, and the drain handler resumes it.
    //
    // The sink is read from currentSink() rather than captured, because an upstream socket is replaced
    // when a connection retries; a queued drain on the old stream must not resume the new one's flow.
    function flush() {
        if (!isOpen() || blocked) return;

        while (frames.length) {
            const sink = currentSink();
            if (!sink) return;

            const frame = frames.shift();
            bytes -= frame.payload.length;

            if (sink.write(encode(frame))) continue;

            blocked = true;
            pauseSource();
            sink.once('drain', () => {
                if (!isOpen() || currentSink() !== sink) return;
                blocked = false;
                flush();
            });
            return;
        }

        resumeSource();
    }

    // Adds a frame and tries to send it. Returns false when the queue is full, which the caller
    // treats as a connection that cannot keep up and closes.
    function push(frame) {
        if (frames.length >= maxFrames || bytes + frame.payload.length > maxBytes) return false;

        frames.push(frame);
        bytes += frame.payload.length;
        flush();
        return true;
    }

    // Drops everything queued. A connection that is closing has nowhere to send it.
    function clear() {
        frames.length = 0;
        bytes = 0;
    }

    return { push, flush, clear };
}

module.exports = { createFrameQueue };
