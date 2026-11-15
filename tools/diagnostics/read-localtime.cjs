// Reports the trail in local wall-clock time.
//
// The trail stores ISO timestamps in UTC (trailing Z). Reading them back without converting produced
// times that did not match the clock on the wall, which makes every before/after comparison in a
// debugging session unreliable. Local time is the only useful form here.
const fs = require('node:fs');
const path = require('node:path');

const EXT_ID = 'kdjgfockdecdbadmpbjgflmiffdiffhp';
const { edgeStoreDir } = require('../machine.cjs');
const STORE = edgeStoreDir(EXT_ID);

const since = process.argv[2] || '';

let text = '';
const sources = [];
for (const name of fs.readdirSync(STORE)) {
    if (!/\.(log|ldb)$/.test(name)) continue;
    const stat = fs.statSync(path.join(STORE, name));
    text += fs.readFileSync(path.join(STORE, name)).toString('latin1');
    sources.push(name + ' @ ' + stat.mtime.toTimeString().slice(0, 8));
}
console.log('files:', sources.join(', '));

function localAt(offset) {
    const before = text.slice(Math.max(0, offset - 3000), offset);
    const stamps = before.match(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g);
    if (!stamps) return null;

    const iso = stamps[stamps.length - 1];
    const d = new Date(iso);
    return d.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

const patterns = [
    { kind: 'code1', re: /\\"code\\": \\"1\\"/g },
    { kind: 'code21', re: /\\"code\\": \\"21\\"/g },
    { kind: 'success', re: /\\"status\\": \\"success\\"/g },
    { kind: 'failed', re: /\\"status\\": \\"failed\\"/g },
    { kind: 'exception', re: /Exception Occured/g },
    { kind: 'invalid', re: /Invalid request/g }
];

const marks = [];
for (const { kind, re } of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
        marks.push({ kind, at: m.index, clock: localAt(m.index) });
    }
}

const ordered = marks
    .filter(m => m.clock)
    .sort((a, b) => a.at - b.at)
    .filter((m, i, all) => i === 0 || m.at !== all[i - 1].at || m.kind !== all[i - 1].kind);

console.log('frames:', ordered.length);

// A compact per-minute table in local time, so the shape of the last session is visible at a glance.
const perMinute = new Map();
for (const m of ordered) {
    const key = m.clock.slice(0, 5);
    if (!perMinute.has(key)) perMinute.set(key, {});
    const bucket = perMinute.get(key);
    bucket[m.kind] = (bucket[m.kind] || 0) + 1;
}

console.log('\nlocal time, per minute:');
for (const [minute, bucket] of [...perMinute.entries()].sort()) {
    const parts = Object.entries(bucket).map(([k, v]) => k + ':' + v).join('  ');
    console.log('  ' + minute + '  ' + parts);
}

const lastOf = {};
for (const m of ordered) lastOf[m.kind] = m.clock;
console.log('\nlast seen (local):', JSON.stringify(lastOf, null, 1));
