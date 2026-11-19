// The extension's trail lives in a LevelDB, and reading it is not the same as reading the .log.
//
// This exists because the trail reader silently stopped working. It read the write-ahead log and only
// fell back to a raw byte scan of the tables, and a raw scan cannot decode a snappy-compressed block -
// so it found the key "zqTrail", failed to parse any value, and printed "Found trail records but none
// parsed" while every run that needed explaining sat in a table. The newest run it could show was
// days older than the one being asked about, and nothing said so.
//
// A synthetic table is written here in the exact layout LevelDB uses, so the reader is exercised end
// to end: footer, index block, data block, snappy, prefix-compressed keys, restart array.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readTables, snappyUncompress } = require('../../tools/diagnostics/leveldb-table.cjs');

const checks = [];
const check = (name, fn) => {
    try {
        fn();
        checks.push(true);
        console.log('  ok    ' + name);
    } catch (error) {
        checks.push(false);
        console.log('  FAIL  ' + name + ' - ' + error.message);
    }
};

// --- a snappy encoder, so the decoder can be tested without a fixture ---------

// Only the literal form is emitted: it is enough to prove the decoder reads a length prefix and
// copies bytes, and it keeps this encoder from being a second implementation of the compressor.
function snappyCompressLiterals(input) {
    const parts = [];
    let remaining = input.length;
    let shift = 0;

    // Uncompressed length, as a varint.
    while (remaining >= 0x80) {
        parts.push(Buffer.from([(remaining & 0x7f) | 0x80]));
        remaining >>>= 7;
        shift += 7;
    }
    parts.push(Buffer.from([remaining]));

    let at = 0;
    while (at < input.length) {
        const chunk = Math.min(input.length - at, 60);
        parts.push(Buffer.from([(chunk - 1) << 2]));
        parts.push(input.subarray(at, at + chunk));
        at += chunk;
    }

    return Buffer.concat(parts);
}

function writeVarint(value) {
    const bytes = [];
    let remaining = value;

    while (remaining >= 0x80) {
        bytes.push((remaining & 0x7f) | 0x80);
        remaining >>>= 7;
    }
    bytes.push(remaining);

    return Buffer.from(bytes);
}

// Prefix-compressed block with one restart per entry: correct, if not maximally compact.
function writeBlock(entries) {
    const parts = [];
    const restarts = [];
    let offset = 0;

    for (const { key, value } of entries) {
        restarts.push(offset);
        const head = Buffer.concat([
            writeVarint(0),
            writeVarint(key.length),
            writeVarint(value.length)
        ]);
        parts.push(head, key, value);
        offset += head.length + key.length + value.length;
    }

    const restartArray = Buffer.alloc(4 * restarts.length);
    restarts.forEach((at, i) => restartArray.writeUInt32LE(at, i * 4));

    const count = Buffer.alloc(4);
    count.writeUInt32LE(restarts.length, 0);

    return Buffer.concat([...parts, restartArray, count]);
}

// A complete single-data-block table: the layout the reader must handle.
function writeTable(entries, { compress = true } = {}) {
    const dataBlock = writeBlock(entries);
    const storedData = compress ? snappyCompressLiterals(dataBlock) : dataBlock;

    // A block on disk is its bytes followed by one compression byte, and a handle points at that
    // pair: (offset, size) where size excludes the compression byte.
    const dataOffset = 0;
    const dataHandle = Buffer.concat([writeVarint(dataOffset), writeVarint(storedData.length)]);

    const indexBlock = writeBlock([{ key: entries[entries.length - 1].key, value: dataHandle }]);
    const storedIndex = compress ? snappyCompressLiterals(indexBlock) : indexBlock;
    const indexOffset = dataOffset + storedData.length + 1;

    const indexHandle = Buffer.concat([writeVarint(indexOffset), writeVarint(storedIndex.length)]);

    // The footer is exactly 48 bytes: metaindex handle, index handle, zero padding, then the magic.
    const metaindexHandle = Buffer.concat([writeVarint(0), writeVarint(0)]);
    const body = Buffer.concat([metaindexHandle, indexHandle]);
    const padding = Buffer.alloc(48 - body.length - 8);
    const magic = Buffer.alloc(8);
    magic.writeBigUInt64LE(0xdb4775248b80fb57n, 0);

    return Buffer.concat([
        storedData, Buffer.from([compress ? 1 : 0]),
        storedIndex, Buffer.from([compress ? 1 : 0]),
        body, padding, magic
    ]);
}

// --- the decoder ------------------------------------------------------------

check('a literal-only block decodes to the original bytes', () => {
    const source = Buffer.from('{"zqTrail":{"7":{"startedAt":"2026-11-18T12:43:00.000Z"}}}');
    const encoded = snappyCompressLiterals(source);

    assert.deepEqual(snappyUncompress(encoded), source);
});

check('a copy element reproduces a run, including overlapping copies', () => {
    // "abcdabcdabcd" as: literal "abcd", then an offset-4 copy of length 8 (kind 2, overlapping).
    const encoded = Buffer.concat([
        Buffer.from([12]),
        Buffer.from([(4 - 1) << 2]),
        Buffer.from('abcd'),
        Buffer.from([((8 - 1) << 2) | 0x02, 0x04, 0x00])
    ]);

    assert.equal(snappyUncompress(encoded).toString(), 'abcdabcdabcd');
});

// --- the table --------------------------------------------------------------

check('a compressed single-block table is read back entry by entry', () => {
    const entries = [
        { key: Buffer.from('relayOnline'), value: Buffer.from('true') },
        { key: Buffer.from('zqTrail'), value: Buffer.from('{"517570326":{"startedAt":"x","events":[]}}') }
    ];

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zq-ldb-'));
    fs.writeFileSync(path.join(dir, '000560.ldb'), writeTable(entries));

    const read = readTables(dir);
    assert.equal(read.length, 2, 'both entries must come back');
    assert.equal(read[0].key, 'relayOnline');
    assert.equal(read[0].value.toString(), 'true');
    assert.equal(read[1].key, 'zqTrail');
    assert.match(read[1].value.toString(), /517570326/);

    fs.rmSync(dir, { recursive: true, force: true });
});

check('an uncompressed block is read too', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zq-ldb-'));
    fs.writeFileSync(path.join(dir, '000001.ldb'),
        writeTable([{ key: Buffer.from('zqTrail'), value: Buffer.from('{"a":1}') }], { compress: false }));

    const read = readTables(dir);
    assert.equal(read.length, 1);
    assert.equal(read[0].value.toString(), '{"a":1}');

    fs.rmSync(dir, { recursive: true, force: true });
});

check('a file that is not a table is refused rather than half-read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zq-ldb-'));
    fs.writeFileSync(path.join(dir, 'garbage.ldb'), Buffer.alloc(200, 0x41));

    assert.deepEqual(readTables(dir), []);

    fs.rmSync(dir, { recursive: true, force: true });
});

check('a missing store directory is empty, not an error', () => {
    assert.deepEqual(readTables(path.join(os.tmpdir(), 'zq-does-not-exist-' + Date.now())), []);
});

// --- the reader actually uses it -------------------------------------------

check('the trail reader reads the tables, not only the write-ahead log', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '..', '..', 'tools', 'diagnostics', 'read-trail.cjs'), 'utf8');

    assert.match(source, /require\('\.\/leveldb-table\.cjs'\)/,
        'the reader must use the table reader');
    assert.match(source, /for \(const entry of tables\)[\s\S]{0,200}zqTrail/,
        'and must prefer table values over the raw byte scan');
});

const failed = checks.filter(ok => !ok).length;
console.log('');
if (failed) {
    console.error(`${failed}/${checks.length} leveldb table checks failed`);
    process.exitCode = 1;
} else {
    console.log(`PASS: ${checks.length}/${checks.length} leveldb table checks`);
}
