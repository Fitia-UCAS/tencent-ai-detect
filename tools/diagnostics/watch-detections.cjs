// Watches the extension's own trail and reports each detection as it completes.
//
// Running a hundred detections by hand is not a real test: the failures this project has chased were
// timing-dependent, and a hand run samples them badly. This reads the trail the extension already
// writes and prints a running tally, so a long run can be watched without touching the browser.
//
// It deliberately does not drive the browser. Driving one would change the timing being measured -
// the whole bug class here is about what happens while a detection is in flight.
const fs = require('node:fs');
const path = require('node:path');

const EXT_ID = 'kdjgfockdecdbadmpbjgflmiffdiffhp';
const { edgeStoreDir } = require('../machine.cjs');
const STORE = edgeStoreDir(EXT_ID);

const intervalMs = Number(process.argv[3]) || 4000;
const sinceArg = process.argv[2] || '00:00';

let lastSeen = 0;
const exchanges = [];
let running = { accepted: false, succeeded: false, refused: false, clock: null };

function readStore() {
    let text = '';
    for (const name of fs.readdirSync(STORE)) {
        if (!/\.(log|ldb)$/.test(name)) continue;
        text += fs.readFileSync(path.join(STORE, name)).toString('latin1');
    }
    return text;
}

function clockAt(text, offset) {
    const before = text.slice(Math.max(0, offset - 2500), offset);
    const stamps = before.match(/\d{4}-\d\d-\d\dT(\d\d:\d\d:\d\d\.\d{3})Z/g);
    return stamps ? stamps[stamps.length - 1].slice(11, 23) : null;
}

function scan() {
    const text = readStore();

    // Only look at the part that has not been processed yet, so a growing log does not replay.
    const start = Math.max(0, lastSeen - 800);
    const slice = text.slice(start);

    const marks = [];
    const patterns = [
        { kind: 'accept', re: /\\"code\\": \\"1\\"/g },
        { kind: 'reject', re: /\\"code\\": \\"(?!1\\)(\d+)\\"/g },
        { kind: 'success', re: /\\"status\\": \\"success\\"/g },
        { kind: 'failed', re: /\\"status\\": \\"failed\\"/g }
    ];

    for (const { kind, re } of patterns) {
        let m;
        while ((m = re.exec(slice)) !== null) {
            marks.push({ kind, at: start + m.index, clock: clockAt(text, start + m.index) });
        }
    }

    lastSeen = text.length;

    marks.sort((a, b) => a.at - b.at);

    for (const mark of marks) {
        if (!mark.clock || mark.clock < sinceArg) continue;

        if (mark.kind === 'accept') {
            if (running.accepted && !running.succeeded && !running.refused) {
                exchanges.push({ ...running, verdict: 'incomplete' });
            }
            running = { accepted: true, succeeded: false, refused: false, clock: mark.clock };
            continue;
        }

        if (!running.accepted) continue;

        if (mark.kind === 'success') running.succeeded = true;
        if (mark.kind === 'reject' || mark.kind === 'failed') running.refused = true;

        if (running.succeeded || running.refused) {
            exchanges.push({
                ...running,
                verdict: running.refused ? 'FAILED' : 'ok'
            });
            running = { accepted: false, succeeded: false, refused: false, clock: null };
        }
    }

    report();
}

function report() {
    const total = exchanges.length;
    if (total === 0) {
        process.stdout.write('.');
        return;
    }

    const ok = exchanges.filter(e => e.verdict === 'ok').length;
    const failed = exchanges.filter(e => e.verdict === 'FAILED').length;
    const incomplete = total - ok - failed;

    process.stdout.write(
        '\n[' + new Date().toTimeString().slice(0, 8) + '] ' +
        'total ' + total + ' | ok ' + ok + ' | failed ' + failed +
        (incomplete ? ' | incomplete ' + incomplete : '') +
        ' | rate ' + ((ok / total) * 100).toFixed(1) + '%\n');

    const last = exchanges[exchanges.length - 1];
    if (last) {
        process.stdout.write('  last: ' + last.clock + ' ' + last.verdict + '\n');
    }
}

process.stdout.write('watching since ' + sinceArg + ', polling every ' + intervalMs + 'ms\n');
scan();
setInterval(scan, intervalMs);
