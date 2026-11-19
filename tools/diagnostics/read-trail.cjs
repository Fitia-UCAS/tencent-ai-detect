// Reads the per-tab event trail out of the extension's own storage.
//
// The trail exists because the steps of a detection are not a fixed sequence - the challenge comes
// up for some presses and not others, the result lands or is replaced, the address rule installs or
// never does - and every guard in this codebase asks "is X true now", which cannot tell a step that
// has not happened from one that already passed. The page's wording is the same either way.
//
// The storage is a LevelDB owned by the browser, so it is read as bytes: records are length-prefixed,
// and the trail is JSON inside one of them. Reading it does not touch the live browser and needs no
// debugging port, which matters because the browser cannot be given one after it has started.
const fs = require('node:fs');
const path = require('node:path');

const EXT_ID = 'kdjgfockdecdbadmpbjgflmiffdiffhp';
const { edgeStoreDir } = require('../machine.cjs');
const { readTables } = require('./leveldb-table.cjs');
const STORE = edgeStoreDir(EXT_ID);

// A record header is crc32(4) | length(2) | type(1). Type 1 is a whole value; a value too large for
// one block arrives as type 2 (first), any number of type 3 (middle), then type 4 (last).
//
// Reading each fragment as a record is how this tool came to print nothing: the trail had grown past
// a block, so the write that held the whole of it was split, the key "zqTrail" appeared only in the
// first fragment, and every fragment on its own was a prefix of the JSON. A run that was recorded in
// full read back as "tab partial" with no events at all.
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

// The tables are compressed blocks, so walking them the same way only recovers literal runs - enough
// to find a trail that survived compaction, never enough to parse one. Kept for that: the log only
// holds what has been written since the last compaction.
function readStorePayloads(dir) {
    const found = [];

    if (!fs.existsSync(dir)) return found;

    for (const name of fs.readdirSync(dir)) {
        if (!/\.ldb$/.test(name)) continue;

        const buf = fs.readFileSync(path.join(dir, name));
        let offset = 0;

        while (offset + 7 <= buf.length) {
            const length = buf.readUInt16LE(offset + 4);
            const type = buf[offset + 6];

            if (length === 0 || offset + 7 + length > buf.length || type < 1 || type > 4) {
                offset += 1;
                continue;
            }

            const payload = buf.slice(offset + 7, offset + 7 + length).toString('utf8');
            if (payload.includes('zqTrail')) found.push(payload);
            offset += 7 + length;
        }
    }

    return found;
}

function extractTrails(payload) {
    // The record holds a key followed by a JSON value. Locate the outermost object after the key.
    const at = payload.indexOf('zqTrail');
    if (at === -1) return null;

    const start = payload.indexOf('{', at);
    if (start === -1) return null;

    // Walk to the matching brace rather than trusting a greedy regex over nested JSON.
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < payload.length; i += 1) {
        const ch = payload[i];

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
                    return JSON.parse(payload.slice(start, i + 1));
                } catch (e) {
                    return null;
                }
            }
        }
    }

    // The trail can outgrow a single LevelDB record once the frames are kept whole, and a record that
    // spans two blocks arrives here truncated. Recovering the events that did parse beats reporting
    // nothing: a diagnosis needs the sequence, and a missing tail is visible in the gaps.
    return salvageEvents(payload.slice(start));
}

// Pulls complete event objects out of a truncated trail.
function salvageEvents(text) {
    const events = [];
    const marker = '"events":[';

    const at = text.indexOf(marker);
    if (at === -1) return null;

    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;

    for (let i = at + marker.length - 1; i < text.length; i += 1) {
        const ch = text[i];

        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }

        if (ch === '"') inString = true;
        else if (ch === '{') {
            if (depth === 0) start = i;
            depth += 1;
        } else if (ch === '}') {
            depth -= 1;
            if (depth === 0 && start !== -1) {
                try {
                    events.push(JSON.parse(text.slice(start, i + 1)));
                } catch (e) {
                    // A half-written event is dropped; the rest still tell the story.
                }
                start = -1;
            }
        } else if (ch === ']' && depth === 0) {
            break;
        }
    }

    if (events.length === 0) return null;

    return { partial: true, events };
}

const values = [];
if (fs.existsSync(STORE)) {
    for (const name of fs.readdirSync(STORE).filter(entry => /\.log$/.test(entry)).sort()) {
        values.push(...readLogValues(path.join(STORE, name)));
    }
}

// The tables, read properly. The byte scan below cannot decode a compressed block, so on a store that
// has been compacted it found the key and no value - which is what made this tool print "none parsed"
// while the runs that needed explaining sat in a table. Oldest table first, so the newest trail is
// whichever one is read last.
const tables = readTables(STORE);

if (values.length === 0 && tables.length === 0) {
    console.log('No trail in storage yet.');
    console.log('The trail is written by the content script, so it appears after a page load runs the');
    console.log('current build. Reload the extension and open the detection page once.');
    process.exit(0);
}

// Complete values first, in the order they were written, so the last one that parses is the newest
// trail. Then the tables, then the byte scan as a last resort - the scan gives a prefix at best, which
// is only worth printing when nothing else parses.
let newest = null;
for (const text of values) {
    const parsed = extractTrails(text.toString('utf8'));
    if (parsed) newest = parsed;
}
for (const entry of tables) {
    if (!entry.key.startsWith('zqTrail')) continue;
    const parsed = extractTrails(entry.value.toString('utf8'));
    if (parsed) newest = parsed;
}

const payloads = readStorePayloads(STORE);
for (const text of payloads) {
    const parsed = extractTrails(text);
    if (parsed) newest = parsed;
}

if (!newest) {
    console.log('Found trail records but none parsed. Raw tail of the newest one:');
    console.log(String(payloads[payloads.length - 1] || '').slice(0, 600));
    process.exit(0);
}

// The trail stores UTC. Reading it back that way produced clocks that did not match the wall and
// made every before/after comparison in a debugging session unreliable, so the local clock is what
// is printed here.
function localClock(iso) {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return String(iso);

    const date = new Date(at);
    return date.toLocaleTimeString('en-GB', { hour12: false }) + '.' +
        String(date.getMilliseconds()).padStart(3, '0');
}

// A salvaged trail has no tab keys - the record it came from was cut - so it is printed as the one
// run it is instead of listing "partial" and "events" as though they were tabs.
const runs = newest.partial ? [['unknown', newest]] : Object.entries(newest);

for (const [tabId, run] of runs) {
    console.log('');
    console.log('=== tab ' + tabId + ' (load began ' +
        (run.startedAt ? localClock(run.startedAt) : 'unknown') + ') ===');

    let previous = null;
    for (const event of run.events || []) {
        const gap = previous ? '+' + (Date.parse(event.t) - Date.parse(previous)) + 'ms' : '';
        // The frames are printed whole: a ticket and a verdict are short, and a report frame's counts
        // are what say whether a refusal cancelled a real result. Shortening them here would be
        // withholding the evidence that was collected precisely to answer this question.
        const detail = event.detail === null || event.detail === undefined
            ? ''
            : ' ' + JSON.stringify(event.detail);

        // The outbound path the relay was leaving by, and how stale that reading was. Printed on the
        // line it belongs to, because the question - was the proxy on when this ticket was refused -
        // is about that moment and the answer is not visible anywhere else.
        const path = event.outbound
            ? ' [' + event.outbound + (event.outboundAgeMs === null ? '' : ' ' +
                Math.round(event.outboundAgeMs / 1000) + 's ago') + ']'
            : '';

        console.log(
            localClock(event.t).padEnd(13) +
            String(gap).padStart(9) + '  ' +
            String(event.name).padEnd(22) + detail + path);

        // The page picture is what the trail cannot say on its own: the same wording means a refusal
        // or a stale view depending on where in the DOM it sits and whether it is visible.
        if (event.page) {
            const page = event.page;
            console.log('    page: state=' + page.state + ' bodyLen=' + page.bodyLen +
                ' quota=' + JSON.stringify(page.quota));

            if (page.challenge) {
                const c = page.challenge;
                console.log('    challenge: open=' + c.open + ' ' + c.w + 'x' + c.h +
                    ' at(' + c.x + ',' + c.y + ') opacity=' + c.opacity + ' display=' + c.display);
            }

            for (const [marker, hits] of Object.entries(page.markers || {})) {
                for (const hit of hits || []) {
                    console.log('    "' + marker + '" in <' + hit.tag +
                        (hit.id ? ' id=' + hit.id : '') +
                        (hit.cls ? ' class=' + JSON.stringify(hit.cls) : '') +
                        '> visible=' + hit.visible);
                    if (hit.text) console.log('      text: ' + JSON.stringify(hit.text.slice(0, 120)));
                }
            }
        }

        previous = event.t;
    }
}
