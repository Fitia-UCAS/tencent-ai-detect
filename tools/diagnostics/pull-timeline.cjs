// Timeline of what the page sent, reconstructed from the stored trail.
//
// 382 tickets sent from 17 distinct values is the number that explained the failures, and the shape
// of that repetition is what says whether the page is retrying a spent ticket or the socket is dying
// under it. A per-minute count separates the two: a burst means a reconnect loop, an even spread
// means each detection is sending the same ticket several times on its own.
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

const ESC = String.fromCharCode(92);

// Each event carries its ISO timestamp before the name. Collect the two together so a send can be
// placed in time without needing the surrounding object to parse.
const pattern = new RegExp(
    'name' + ESC + '":' + ESC + '"(relay-sent|relay-frame|press|load|reload)' + ESC + '"',
    'g');

const events = [];
let match;
while ((match = pattern.exec(text)) !== null) {
    const name = match[1];

    // Walk backwards to the nearest timestamp in this record.
    const start = Math.max(0, match.index - 400);
    const before = text.slice(start, match.index);
    const stamps = before.match(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g);

    events.push({ name, t: stamps ? stamps[stamps.length - 1] : null });
}

const usable = events.filter(e => e.t);
console.log('events with timestamps:', usable.length, 'of', events.length);

const byMinute = new Map();
for (const e of usable) {
    const minute = e.t.slice(11, 16);
    const key = minute + ' ' + e.name;
    byMinute.set(key, (byMinute.get(key) || 0) + 1);
}

console.log('\nper-minute counts (minute, event, count):');
[...byMinute.entries()]
    .sort()
    .forEach(([key, count]) => {
        if (count >= 2) console.log('  ' + key + '  x' + count);
    });

const total = {};
for (const e of usable) total[e.name] = (total[e.name] || 0) + 1;
console.log('\ntotals:', JSON.stringify(total, null, 1));
