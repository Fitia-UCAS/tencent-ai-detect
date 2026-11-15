// Reads the frames recorded since a given clock time, in order.
//
// The store is a ring per tab, so the newest run is the tail. The frames carry the timestamp inside
// their own event object, which is what makes a window possible: after fixing a loop, the totals still
// include every failure the loop produced, and only a windowed view says whether it works now.
const fs = require('node:fs');
const path = require('node:path');

const EXT_ID = 'kdjgfockdecdbadmpbjgflmiffdiffhp';
const STORE = path.join(
    process.env.LOCALAPPDATA || 'C:/Users/aFei/AppData/Local',
    'Microsoft/Edge/User Data/Default/Local Extension Settings', EXT_ID);

const sinceArg = process.argv[2] || '08:45';

let text = '';
for (const name of fs.readdirSync(STORE)) {
    if (!/\.(log|ldb)$/.test(name)) continue;
    const buf = fs.readFileSync(path.join(STORE, name));
    text += buf.toString('latin1');
}

// The stored JSON is escaped, so the fields appear as \"status\": \"success\". Capture each occurrence
// with its offset, then translate the offset back to a clock time by finding the nearest preceding
// timestamp in the same string.
function clockAt(offset) {
    const before = text.slice(Math.max(0, offset - 2000), offset);
    const stamps = before.match(/\d{4}-\d\d-\d\dT(\d\d:\d\d:\d\d\.\d{3})Z/g);
    if (!stamps) return null;
    return stamps[stamps.length - 1].slice(11, 23);
}

// Verdicts and refusals, in arrival order, with the time each was recorded.
const findings = [];
const patterns = [
    { kind: 'code', re: /\\"code\\": \\"(\d+)\\"/g },
    { kind: 'status', re: /\\"status\\": \\"(success|failed|waiting)\\"/g },
    { kind: 'refusal', re: /Invalid request/g }
];

for (const { kind, re } of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
        findings.push({ kind, value: m[1] || 'Invalid request', at: m.index, clock: clockAt(m.index) });
    }
}

const recent = findings
    .filter(f => f.clock && f.clock >= sinceArg)
    .sort((a, b) => a.at - b.at);

console.log('frames since ' + sinceArg + ':', recent.length);

const tally = {};
for (const f of recent) {
    const key = f.kind === 'code' ? 'code:' + f.value
        : f.kind === 'status' ? 'status:' + f.value
            : 'refusal';
    tally[key] = (tally[key] || 0) + 1;
}
console.log('tally:', JSON.stringify(tally, null, 1));

console.log('\nsequence (last 40):');
for (const f of recent.slice(-40)) {
    console.log('  ' + f.clock + '  ' + f.kind + ' ' + f.value);
}
