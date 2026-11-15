// Writes a zip from a file list, with no external tool.
//
// This exists because both compressors available here get the layout wrong or refuse the path:
// PowerShell's Compress-Archive flattens directory contents into the archive root when given a
// glob, and the tar first on PATH is GNU tar from Git Bash, which reads the colon in C:\ as a
// remote host. A published extension whose zip is flat installs fine and then cannot find a single
// file the manifest names, so the layout is the one part of this worth controlling directly.
//
// Entry names are always forward-slash, which is what the zip specification requires and what every
// extractor and the browser itself expect.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

// Fixed timestamp (1980-01-01) so the same sources produce the same bytes: a published archive
// should not change just because it was built a minute later.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

function buildZip(root, files) {
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const name of files) {
        const content = fs.readFileSync(path.join(root, name));
        const deflated = zlib.deflateRawSync(content, { level: 9 });

        // Store instead of deflate when deflating made it bigger. Both are valid entries; the
        // smaller one is chosen because a published download should not carry padding.
        const useDeflate = deflated.length < content.length;
        const body = useDeflate ? deflated : content;
        const method = useDeflate ? 8 : 0;
        const crc = zlib.crc32(content) >>> 0;
        const nameBytes = Buffer.from(name, 'utf8');

        const local = Buffer.alloc(30);
        local.writeUInt32LE(LOCAL_SIG, 0);
        local.writeUInt16LE(20, 4);               // version needed to extract
        local.writeUInt16LE(0x0800, 6);           // UTF-8 names
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(DOS_TIME, 10);
        local.writeUInt16LE(DOS_DATE, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);     // compressed size
        local.writeUInt32LE(content.length, 22);  // uncompressed size
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(0, 28);               // no extra field

        chunks.push(local, nameBytes, body);

        const dir = Buffer.alloc(46);
        dir.writeUInt32LE(CENTRAL_SIG, 0);
        dir.writeUInt16LE(20, 4);                 // version made by
        dir.writeUInt16LE(20, 6);                 // version needed
        dir.writeUInt16LE(0x0800, 8);
        dir.writeUInt16LE(method, 10);
        dir.writeUInt16LE(DOS_TIME, 12);
        dir.writeUInt16LE(DOS_DATE, 14);
        dir.writeUInt32LE(crc, 16);
        dir.writeUInt32LE(body.length, 20);
        dir.writeUInt32LE(content.length, 24);
        dir.writeUInt16LE(nameBytes.length, 28);
        dir.writeUInt16LE(0, 30);                 // extra
        dir.writeUInt16LE(0, 32);                 // comment
        dir.writeUInt16LE(0, 34);                 // disk number
        dir.writeUInt16LE(0, 36);                 // internal attributes
        dir.writeUInt32LE(0, 38);                 // external attributes
        dir.writeUInt32LE(offset, 42);            // local header offset

        central.push(dir, nameBytes);
        offset += local.length + nameBytes.length + body.length;
    }

    const centralBuffer = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4);                     // this disk
    eocd.writeUInt16LE(0, 6);                     // disk with central directory
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(centralBuffer.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);                    // no comment

    return Buffer.concat([Buffer.concat(chunks), centralBuffer, eocd]);
}

module.exports = { buildZip };
