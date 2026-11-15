// Reconstructs the frame sequence around each failure, to tell the failure kinds apart.
//
// Two different things are being called "a failure" in the page's wording: the server answering code
// 21, which is the captcha handshake being refused, and a failed status whose message is "Exception
// Occured!", which arrives after the detection was accepted. They have different causes and different
// fixes, so counting them together hid which one was happening.
const fs = require('node:fs');
const path = require('node:path');

const EXT_ID = 'kdjgfockdecdbadmpbjgflmiffdiffhp';
const { edgeStoreDir } = require('../machine.cjs');
const STORE = edgeStoreDir(EXT_ID);

let text = '';
for (const name of fs.readdirSync(STORE)) {
    if (!/\.(log|ldb)$/.test(name)) continue;
    text += fs.readFileSync(path.join(STORE, name)).toString('latin1');
}

function clockAt(offset) {
    const before = text.slice(Math.max(0, offset - 2500), offset);
    const stamps = before.match(/\d{4}-\d\d-\d\dT(\d\d:\d\d:\d\d\.\d{3})Z/g);
    return stamps ? stamps[stamps.length - 1].slice(11, 23) : null;
}

// Every frame the server sent, in order, with what it said.
const frames = [];

const patterns = [
    { kind: 'code1', re: /\\"code\\": \\"1\\"/g },
    { kind: 'code21', re: /\\"code\\": \\"21\\"/g },
    { kind: 'exception', re: /Exception Occured/g },
    { kind: 'success', re: /\\"status\\": \\"success\\"/g },
    { kind: 'waiting', re: /\\"status\\": \\"waiting\\"/g },
    { kind: 'invalid', re: /Invalid request/g }
];

for (const { kind, re } of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
        frames.push({ kind, at: m.index, clock: clockAt(m.index) });
    }
}

const ordered = frames
    .filter(f => f.clock)
    .sort((a, b) => a.at - b.at)
    .filter((f, i, all) => i === 0 || f.at !== all[i - 1].at || f.kind !== all[i - 1].kind);

console.log('frames:', ordered.length);

const tally = {};
for (const f of ordered) tally[f.kind] = (tally[f.kind] || 0) + 1;
console.log('tally:', JSON.stringify(tally, null, 1));

// The window around each exception, because what precedes it says whether the detection ran at all.
const exceptions = ordered.filter(f => f.kind === 'exception');
console.log('\nexception windows (3 frames either side):');
for (const exception of exceptions.slice(-6)) {
    const at = ordered.indexOf(exception);
    const from = Math.max(0, at - 3);
    const to = Math.min(ordered.length, at + 3);

    const around = ordered.slice(from, to).map(f =>
        (f === exception ? '[' + f.kind + ']' : f.kind));
    console.log('  ' + exception.clock + '  ' + around.join(' -> '));
}

// And the same for refusals, so the two shapes can be compared.
const refusals = ordered.filter(f => f.kind === 'code21');
console.log('\ncode21 windows (last 4):');
for (const refusal of refusals.slice(-4)) {
    const at = ordered.indexOf(refusal);
    const from = Math.max(0, at - 3);
    const to = Math.min(ordered.length, at + 3);

    const around = ordered.slice(from, to).map(f =>
        (f === refusal ? '[' + f.kind + ']' : f.kind));
    console.log('  ' + refusal.clock + '  ' + around.join(' -> '));
}

// When did each kind last appear? A fix is only proven by the newest frames, not by the average.
const lastSeen = {};
for (const f of ordered) lastSeen[f.kind] = f.clock;
console.log('\nlast seen:', JSON.stringify(lastSeen, null, 1));
