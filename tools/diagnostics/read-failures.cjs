// Reconstructs each failure from the trail, one line per answer.
//
// Two different things are called "a failure" in the page's wording: the server answering code 21,
// which is the captcha handshake being refused, and a failed status whose message is "Exception
// Occured!", which arrives after the detection was accepted. They have different causes and
// different fixes, so counting them together hid which one was happening.
//
// The counts were also wrong. This used to scan the raw storage bytes for the wording, which finds
// every copy of it: the trail is rewritten in full on each event and the append log keeps the older
// revisions, so two failures in one load read as 130. That is why a count could never be matched to
// the detections the user actually ran. The trail itself is read here instead - the newest revision,
// reassembled if it was written across more than one block - so each frame is counted once.
//
// The four questions a failure has to answer, in this order:
//   * which detection of that load it was
//   * whether the challenge had anything to do with it: open at the press, or a code 21 before it
//   * whether it cost a use of the address
//   * whether it came out of the socket or out of the page, because a page exception needs a
//     different instrument entirely (see the note at the end)
const fs = require('node:fs');
const path = require('node:path');

const EXT_ID = 'kdjgfockdecdbadmpbjgflmiffdiffhp';
const { edgeStoreDir } = require('../machine.cjs');
const STORE = edgeStoreDir(EXT_ID);

// A record header is crc32(4) | length(2) | type(1); a value larger than one block arrives as type 2
// (first), any number of type 3 (middle), then type 4 (last). Treating each fragment as a record
// finds the key only in the first one, which is how a fully recorded trail read back as empty.
function readLogValues(file) {
    const buf = fs.readFileSync(file);
    const values = [];
    let pending = null;
    let offset = 0;

    while (offset + 7 <= buf.length) {
        const length = buf.readUInt16LE(offset + 4);
        const type = buf[offset + 6];

        if (length === 0 || offset + 7 + length > buf.length || type < 1 || type > 4) {
            offset += 1;
            continue;
        }

        const fragment = buf.slice(offset + 7, offset + 7 + length);

        if (type === 1) {
            pending = null;
            values.push(fragment);
        } else if (type === 2) {
            pending = [fragment];
        } else if (type === 3) {
            if (pending) pending.push(fragment);
        } else if (pending) {
            pending.push(fragment);
            values.push(Buffer.concat(pending));
            pending = null;
        }

        offset += 7 + length;
    }

    return values;
}

// The trail value sits behind its key inside the record. The outermost object after the key is the
// whole store - tab id -> run - so it is found by matching braces rather than by a greedy pattern.
function extractTrail(text) {
    const at = text.indexOf('zqTrail');
    if (at === -1) return null;

    const start = text.indexOf('{', at);
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i += 1) {
        const ch = text[i];

        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }

        if (ch === '"') inString = true;
        else if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                try {
                    return JSON.parse(text.slice(start, i + 1));
                } catch (e) {
                    return null;
                }
            }
        }
    }

    return null;
}

function localClock(iso) {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return String(iso);

    const date = new Date(at);
    return date.toLocaleTimeString('en-GB', { hour12: false }) + '.' +
        String(date.getMilliseconds()).padStart(3, '0');
}

function millis(iso) {
    const at = Date.parse(iso);
    return Number.isFinite(at) ? at : null;
}

if (!fs.existsSync(STORE)) {
    console.log('No extension storage at ' + STORE);
    process.exit(0);
}

const logNames = fs.readdirSync(STORE).filter(name => /\.log$/.test(name)).sort();

let trail = null;
let revisions = 0;
for (const name of logNames) {
    for (const value of readLogValues(path.join(STORE, name))) {
        const parsed = extractTrail(value.toString('utf8'));
        if (!parsed) continue;
        revisions += 1;
        trail = parsed;
    }
}

console.log('files: ' + (logNames.join(', ') || 'none'));
console.log('trail revisions read: ' + revisions + ' (the newest one is reported below)');

if (!trail) {
    console.log('\nNo trail parsed. Load the detection page once with the current build, then run this');
    console.log('again - the trail is written by the content script as it works.');
    process.exit(0);
}

// --- one pass over the frames -------------------------------------------------

const loads = Object.entries(trail).map(([tabId, run]) => ({
    tabId,
    run,
    events: (run.events || []).map((event, index) => ({ ...event, index }))
}));

const totalFailures = loads.reduce((sum, load) =>
    sum + load.events.filter(isServerFailure).length, 0);

console.log('loads in the trail: ' + loads.length + ', server failures: ' + totalFailures);

function detailOf(event) {
    return event && event.detail && typeof event.detail.body === 'string' ? event.detail.body : '';
}

function isServerFailure(event) {
    if (event.name !== 'relay-frame') return false;
    return /Exception Occured/.test(detailOf(event));
}

function isRefusal(event) {
    if (event.name !== 'relay-frame') return false;
    return /"code": "21"/.test(detailOf(event)) || /Invalid request/.test(detailOf(event));
}

function isReport(event) {
    return event.name === 'relay-frame' && /"status": "success"/.test(detailOf(event))
        && /"confidence"/.test(detailOf(event));
}

function isAccept(event) {
    return event.name === 'relay-frame' && /"code": "1"/.test(detailOf(event));
}

function isText(event) {
    return event.name === 'relay-sent' && detailOf(event).indexOf('{"text"') === 0;
}

function md5(text) {
    return require('node:crypto').createHash('md5').update(text).digest('hex').slice(0, 8);
}

// A frame is identified by what it was, not by its first characters: the text frame is a kilobyte of
// prose and truncating it in the middle of a character tells the reader nothing.
function label(event) {
    const body = detailOf(event);

    if (event.name === 'relay-sent') {
        if (body.indexOf('{"fp"') === 0) return 'sent(fp)';
        if (body.indexOf('{"ticket"') === 0) return 'sent(ticket)';
        if (body.indexOf('{"text"') === 0) return 'sent(text ' + body.length + 'b)';
        return 'sent(' + body.slice(0, 20) + ')';
    }

    if (event.name !== 'relay-frame') return event.name;

    const code = body.match(/"code": "(\d+)"/);
    if (code) return 'recv(code ' + code[1] + ')';

    const uses = body.match(/"availableUses": (\d+)/);
    if (uses) return 'recv(availableUses ' + uses[1] + ')';
    if (/"confidence"/.test(body)) return 'recv(report)';
    if (/"waiting"/.test(body)) return 'recv(waiting)';

    const msg = body.match(/"msg": "([^"]+)"/);
    if (msg) return 'recv(failed: ' + msg[1] + ')';

    return 'recv(' + body.slice(0, 20) + ')';
}

for (const { tabId, run, events } of loads) {
    const failures = events.filter(isServerFailure);
    const refusals = events.filter(e => e.name === 'relay-frame' && /"code": "21"/.test(detailOf(e)));
    const accepts = events.filter(isAccept);
    const texts = events.filter(isText);
    const reports = events.filter(isReport);

    console.log('');
    console.log('== tab ' + tabId + '  load began ' +
        (run.startedAt ? localClock(run.startedAt) : 'unknown') + '  (' + events.length + ' events)');
    console.log('   accepted detections: ' + accepts.length +
        '   reports: ' + reports.length +
        '   server failures: ' + failures.length +
        '   code 21 refusals: ' + refusals.length);

    for (const failure of failures) {
        // The detection it belongs to: the accepted handshake it followed.
        const ordinal = accepts.filter(event => event.index < failure.index).length;
        const before = events.filter(event => event.index < failure.index).slice(-3);
        const refusalsBefore = refusals.filter(event => event.index < failure.index).length;

        // The press that started it, if the trail caught one: that is where the challenge state was
        // sampled, and it is the only place "was the captcha up" can be answered for this detection.
        const press = events.filter(event =>
            event.name === 'press' && event.index < failure.index).pop();

        const waiting = events.filter(event =>
            event.name === 'relay-frame' && /"status": "waiting"/.test(detailOf(event)) &&
            event.index < failure.index).pop();

        // The submission this failure answers, and whether the same bytes were answered before.
        const text = texts.filter(event => event.index < failure.index).pop();
        const sameOk = text
            ? reports.filter(report =>
                texts.some(other => other.index < report.index &&
                    md5(detailOf(other)) === md5(detailOf(text))))
            : [];

        console.log('');
        console.log('   #' + ordinal + ' of ' + accepts.length + '   ' +
            localClock(failure.t) + '   server failure: ' + JSON.stringify(
                (detailOf(failure).match(/"msg": "([^"]+)"/) || [])[1] || ''));
        console.log('      came from      a reply frame on the socket, so what the page shows is the');
        console.log('                     site rendering this frame, not an exception of its own');
        console.log('      after          ' + before.map(label).join(' -> '));
        console.log('      waiting gap    ' + (waiting
            ? (millis(failure.t) - millis(waiting.t)) + 'ms after the "waiting" frame'
            : 'no "waiting" frame before it'));
        console.log('      challenge      ' + (press
            ? 'open at the press: ' + (press.detail && press.detail.challengeOpen ? 'yes' : 'no') +
              '; page said ' + JSON.stringify(press.detail && press.detail.state)
            : 'no press recorded before it'));
        console.log('      code 21 before ' + (refusalsBefore ? refusalsBefore + ' in this load' : 'none in this load'));
        const earlierReports = reports.filter(report => report.index < failure.index).length;
        console.log('      allowance      ' + ((detailOf(failure).match(/"availableUses": (\d+)/) ||
            [])[1] || '?') + ' left in the frame; ' + earlierReports + ' report' +
            (earlierReports === 1 ? '' : 's') + ' before it');
        if (text) {
            console.log('      text           ' + md5(detailOf(text)) + ' (' +
                String(detailOf(text).length) + 'b), and the same bytes were answered with a report ' +
                sameOk.length + ' time(s) in this load');
        }
    }

    // The refusal shape, for comparison: it is preceded by code 21 and it is the ticket, not the
    // text, that was refused.
    for (const refusal of refusals.slice(-2)) {
        const ordinal = accepts.filter(event => event.index < refusal.index).length;
        console.log('');
        console.log('   #' + ordinal + ' of ' + accepts.length + '   ' +
            localClock(refusal.t) + '   code 21 ' + detailOf(refusal).trim());
    }
}

console.log('');
console.log('A page-level exception would not appear in any of this: the trail records what the');
console.log('extension did and what the socket carried, and the content script installs no global');
console.log('error handler. Reproducing one live is what diag-auto-flow and diag-sidepanel-errors');
console.log('do - both print Runtime.exceptionThrown - but neither is needed for this failure while');
console.log('the wording it shows is present in a reply frame.');
