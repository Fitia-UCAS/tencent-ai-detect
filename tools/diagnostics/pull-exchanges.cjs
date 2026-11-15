// Walks every recorded exchange and reports each one as a pass or a failure.
//
// The per-minute counts answer "is it reloading too much" but not "did each detection work". This
// reconstructs exchanges instead: a code:1 opens one, the status frames close it, and anything else
// in between is what went wrong. That is the unit the user cares about, and the only way to say
// "180 of 180 succeeded" rather than "no Invalid request appeared".
const fs = require('node:fs');
const path = require('node:path');

const EXT_ID = 'kdjgfockdecdbadmpbjgflmiffdiffhp';
const STORE = path.join(
    process.env.LOCALAPPDATA || 'C:/Users/aFei/AppData/Local',
    'Microsoft/Edge/User Data/Default/Local Extension Settings', EXT_ID);

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

// Collect the markers that describe an exchange, in arrival order.
const marks = [];

const patterns = [
    { kind: 'accept', re: /\\"code\\": \\"1\\"/g },
    { kind: 'reject', re: /\\"code\\": \\"(\d+)\\"/g },
    { kind: 'success', re: /\\"status\\": \\"success\\"/g },
    { kind: 'failed', re: /\\"status\\": \\"failed\\"/g },
    { kind: 'waiting', re: /\\"status\\": \\"waiting\\"/g }
];

for (const { kind, re } of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
        // A reject is any code that is not 1; the accept pattern owns those.
        if (kind === 'reject' && m[1] === '1') continue;

        marks.push({ kind, value: m[1], at: m.index, clock: clockAt(m.index) });
    }
}

const ordered = marks
    .filter(m => m.clock)
    .sort((a, b) => a.at - b.at)
    .filter((m, i, all) => i === 0 || m.at !== all[i - 1].at || m.kind !== all[i - 1].kind);

// Each accept begins an exchange; the next accept bounds it.
const exchanges = [];
let current = null;

for (const mark of ordered) {
    if (mark.kind === 'accept') {
        if (current) exchanges.push(current);
        current = { clock: mark.clock, accepted: true, succeeded: false, refused: false, sawWaiting: false };
        continue;
    }

    if (!current) continue;

    if (mark.kind === 'success') current.succeeded = true;
    if (mark.kind === 'reject') current.refused = true;
    if (mark.kind === 'failed') current.refused = true;
    if (mark.kind === 'waiting') current.sawWaiting = true;
}

if (current) exchanges.push(current);

const total = exchanges.length;
const ok = exchanges.filter(e => e.succeeded && !e.refused).length;
const refused = exchanges.filter(e => e.refused).length;

console.log('exchanges reconstructed:', total);
console.log('  completed with a result:', ok);
console.log('  refused:', refused);
console.log('  neither (incomplete):', total - ok - refused);

if (total > 0) {
    console.log('  success rate:', ((ok / total) * 100).toFixed(1) + '%');
}

// The last stretch, which is what the user is actually asking about.
console.log('\nlast 20 exchanges:');
for (const exchange of exchanges.slice(-20)) {
    const verdict = exchange.refused ? 'FAILED' : exchange.succeeded ? 'ok' : 'incomplete';
    console.log('  ' + exchange.clock + '  ' + verdict);
}
