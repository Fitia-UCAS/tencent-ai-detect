// Reads a zip written by scripts/zip-writer.cjs, in plain Node.
//
// The reason this is not `unzip` or PowerShell: the release archive is built by a GitHub workflow on
// Ubuntu and by hand on Windows, and the two must produce and check the same thing. An external
// lister means the check silently differs by platform, or does not run at all on the one that lacks
// the tool - which is how a flattened archive reaches a download in the first place.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

// The end-of-central-directory record sits at the end, before an optional comment. Scanning backwards
// is how every reader finds it, since the comment length is only known from the record itself.
function findEnd(buffer) {
    const earliest = Math.max(0, buffer.length - 22 - 0xffff);

    for (let at = buffer.length - 22; at >= earliest; at--) {
        if (buffer.readUInt32LE(at) === EOCD_SIG) return at;
    }

    throw new Error('no end-of-central-directory record; this is not a zip archive');
}

// Returns [{ name, size }] for every file in the archive, in central-directory order.
function listZip(file) {
    const buffer = fs.readFileSync(file);
    const end = findEnd(buffer);

    const count = buffer.readUInt16LE(end + 10);
    let at = buffer.readUInt32LE(end + 16); // offset of the central directory

    const entries = [];

    for (let i = 0; i < count; i++) {
        if (buffer.readUInt32LE(at) !== CENTRAL_SIG) {
            throw new Error('central directory record ' + i + ' is not where it claims to be');
        }

        const nameLength = buffer.readUInt16LE(at + 28);
        const extraLength = buffer.readUInt16LE(at + 30);
        const commentLength = buffer.readUInt16LE(at + 32);
        const size = buffer.readUInt32LE(at + 24);
        const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);

        entries.push({ name, size });
        at += 46 + nameLength + extraLength + commentLength;
    }

    return entries;
}

// Writes every entry to `dir`. Directory entries are skipped; their parents are made as needed.
function extractZip(file, dir) {
    const buffer = fs.readFileSync(file);
    const end = findEnd(buffer);

    const count = buffer.readUInt16LE(end + 10);
    let at = buffer.readUInt32LE(end + 16);

    const written = [];

    for (let i = 0; i < count; i++) {
        const method = buffer.readUInt16LE(at + 10);
        const compressedSize = buffer.readUInt32LE(at + 20);
        const size = buffer.readUInt32LE(at + 24);
        const nameLength = buffer.readUInt16LE(at + 28);
        const extraLength = buffer.readUInt16LE(at + 30);
        const commentLength = buffer.readUInt16LE(at + 32);
        const localOffset = buffer.readUInt32LE(at + 42);
        const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);

        at += 46 + nameLength + extraLength + commentLength;

        if (name.endsWith('/')) continue;

        // The local header repeats the name and extra field with its own lengths, which can differ
        // from the central copy; the data starts after them.
        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        const raw = buffer.subarray(start, start + compressedSize);

        const content = method === 8 ? zlib.inflateRawSync(raw) : raw;

        if (content.length !== size) {
            throw new Error('size mismatch in ' + name + ': expected ' + size + ', got ' + content.length);
        }

        const target = path.join(dir, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
        written.push(name);
    }

    return written;
}

module.exports = { listZip, extractZip };
