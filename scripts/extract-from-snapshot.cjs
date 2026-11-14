// Extracts one file's content from a project_snapshot.py snapshot.
// Usage: node scripts/extract-from-snapshot.cjs <snapshot.txt> <path> [outFile]

const fs = require('node:fs');

const [snapshotPath, wanted, outFile] = process.argv.slice(2);

if (!snapshotPath || !wanted) {
    process.stderr.write('usage: extract-from-snapshot.cjs <snapshot> <path> [out]\n');
    process.exit(2);
}

const lines = fs.readFileSync(snapshotPath, 'utf8').split('\n');
const HEADER_RE = /^(.+) 的内容 \[(.*)\]:$/;
const END_RE = /^<<<END FILE/;

let current = null;
let buffer = [];
let found = null;

for (const line of lines) {
    const header = line.match(HEADER_RE);

    if (header) {
        current = header[1];
        buffer = [];
        continue;
    }

    // The header is followed by a row of '=' separators, which is not content.
    if (current !== null && buffer.length === 0 && /^={10,}$/.test(line)) {
        continue;
    }

    if (END_RE.test(line)) {
        if (current !== null && current === wanted && found === null) {
            found = buffer.join('\n');
        }
        current = null;
        buffer = [];
        continue;
    }

    if (current !== null) buffer.push(line);
}

if (found === null) {
    process.stderr.write(`not found: ${wanted}\n`);
    process.exit(1);
}

if (outFile) {
    fs.writeFileSync(outFile, found);
    process.stdout.write(`wrote ${outFile} (${found.split('\n').length} lines)\n`);
} else {
    process.stdout.write(found);
}
