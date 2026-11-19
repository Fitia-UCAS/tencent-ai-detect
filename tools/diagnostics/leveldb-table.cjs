// Reads the table (.ldb) files of the extension's LevelDB store.
//
// tools/diagnostics/read-trail.cjs could only read the write-ahead log, and said so: "the log only
// holds what has been written since the last compaction". Measured on this machine, that made the
// reader useless for diagnosis - the trail had been compacted into a table, so the reader printed
// "Found trail records but none parsed" and the newest run it could show was days old, while the
// runs that actually needed explaining were all in the table.
//
// A table is: data blocks, then an index block, then a footer. Blocks are snappy-compressed, and
// each block is a sequence of prefix-compressed entries with a restart array at the end. The snappy
// decoder below is the subset LevelDB emits (literals and two-byte-offset copies); it is here rather
// than as a dependency because this repository ships no runtime dependencies at all.
const fs = require('node:fs');
const path = require('node:path');

const TABLE_MAGIC = 0xdb4775248b80fb57n;

// --- snappy -----------------------------------------------------------------

// LevelDB compresses each block with snappy: a varint of the uncompressed length, then a sequence of
// elements, each a tag byte whose low two bits pick the shape.
function snappyUncompress(input) {
    let at = 0;

    // Uncompressed length, as a little-endian varint.
    let expected = 0;
    let shift = 0;
    while (at < input.length) {
        const byte = input[at];
        at += 1;
        expected += (byte & 0x7f) * Math.pow(2, shift);
        if ((byte & 0x80) === 0) break;
        shift += 7;
    }

    if (expected === 0) return Buffer.alloc(0);

    const out = Buffer.allocUnsafe(expected);
    let written = 0;

    while (at < input.length && written < expected) {
        const tag = input[at];
        at += 1;
        const kind = tag & 0x03;

        if (kind === 0) {
            // Literal: the length lives in the upper six bits, 60..63 meaning "read 1..4 more bytes".
            let length = tag >>> 2;
            if (length >= 60) {
                const extra = length - 59;
                length = 0;
                for (let i = 0; i < extra; i += 1) length += input[at + i] * Math.pow(2, 8 * i);
                at += extra;
            }
            length += 1;

            if (at + length > input.length || written + length > expected) break;
            input.copy(out, written, at, at + length);
            at += length;
            written += length;
            continue;
        }

        // Copies reference already-written output: offset is 11 or 16 bits, length 4..64.
        let length;
        let offset;

        if (kind === 1) {
            length = 4 + ((tag >>> 2) & 0x07);
            offset = ((tag >>> 5) << 8) | input[at];
            at += 1;
        } else if (kind === 2) {
            length = 1 + (tag >>> 2);
            offset = input[at] | (input[at + 1] << 8);
            at += 2;
        } else {
            length = 1 + (tag >>> 2);
            offset = (input[at] | (input[at + 1] << 8) | (input[at + 2] << 16) | (input[at + 3] << 24)) >>> 0;
            at += 4;
        }

        if (offset === 0 || offset > written) break;

        // Overlapping copies are legal and are how snappy encodes runs.
        for (let i = 0; i < length && written < expected; i += 1) {
            out[written] = out[written - offset];
            written += 1;
        }
    }

    return out.subarray(0, written);
}

// --- block reading ----------------------------------------------------------

function readVarint(buf, at) {
    let result = 0;
    let shift = 0;
    let offset = at;

    while (offset < buf.length) {
        const byte = buf[offset];
        result += (byte & 0x7f) * Math.pow(2, shift);
        offset += 1;
        if ((byte & 0x80) === 0) return { value: result, offset };
        shift += 7;
    }

    return { value: result, offset };
}

// A block handle is (offset, size), both varints.
function readBlock(buf, offset, size) {
    if (offset < 0 || size <= 0 || offset + size + 5 > buf.length + 4) return null;

    const raw = buf.subarray(offset, offset + size);
    const compression = buf[offset + size];

    if (compression === 0) return raw;
    if (compression === 1) return snappyUncompress(raw);
    return null;
}

// Entries are (shared, non_shared, value_length, key_delta, value) with the shared prefix taken from
// the previous key; the last four bytes of the block are the restart count.
function blockEntries(data) {
    const entries = [];
    if (!data || data.length < 4) return entries;

    const restartCount = data.readUInt32LE(data.length - 4);
    const limit = data.length - 4 - restartCount * 4;
    if (limit <= 0) return entries;

    let offset = 0;
    let lastKey = Buffer.alloc(0);

    while (offset < limit) {
        const shared = readVarint(data, offset);
        const nonShared = readVarint(data, shared.offset);
        const valueLength = readVarint(data, nonShared.offset);

        const keyStart = valueLength.offset;
        const keyEnd = keyStart + nonShared.value;
        const valueEnd = keyEnd + valueLength.value;

        if (keyEnd > data.length || valueEnd > data.length) break;

        const key = Buffer.concat([lastKey.subarray(0, shared.value), data.subarray(keyStart, keyEnd)]);
        entries.push({ key, value: data.subarray(keyEnd, valueEnd) });
        lastKey = key;

        offset = valueEnd;
    }

    return entries;
}

// --- table ------------------------------------------------------------------

function tableEntries(file) {
    const buf = fs.readFileSync(file);
    if (buf.length < 48) return [];

    // The footer ends with a fixed magic; checking it is what tells a table from any other file that
    // happens to be in the directory.
    if (buf.readBigUInt64LE(buf.length - 8) !== TABLE_MAGIC) return [];

    const footerAt = buf.length - 48;
    const meta = readVarint(buf, footerAt);
    const metaHandle = readVarint(buf, meta.offset);
    const index = readVarint(buf, metaHandle.offset);
    const indexHandle = readVarint(buf, index.offset);

    const indexBlock = readBlock(buf, index.value, indexHandle.value);
    if (!indexBlock) return [];

    const entries = [];
    for (const entry of blockEntries(indexBlock)) {
        const handleOffset = readVarint(entry.value, 0);
        const handleSize = readVarint(entry.value, handleOffset.offset);

        const data = readBlock(buf, handleOffset.value, handleSize.value);
        if (!data) continue;

        entries.push(...blockEntries(data));
    }

    return entries;
}

// Every key/value pair in every table of a store directory, in file then key order.
function readTables(dir) {
    const out = [];

    if (!fs.existsSync(dir)) return out;

    for (const name of fs.readdirSync(dir).filter(entry => /\.ldb$/.test(entry)).sort()) {
        for (const entry of tableEntries(path.join(dir, name))) {
            out.push({
                file: name,
                key: entry.key.toString('utf8'),
                value: entry.value
            });
        }
    }

    return out;
}

module.exports = { readTables, tableEntries, snappyUncompress };
