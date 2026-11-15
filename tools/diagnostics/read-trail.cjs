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
const STORE = path.join(
    process.env.LOCALAPPDATA || 'C:/Users/aFei/AppData/Local',
    'Microsoft/Edge/User Data/Default/Local Extension Settings', EXT_ID);

// Scans every record for a JSON payload that carries the trail key. A partial match is normal: records
// are appended, so the newest version of the trail is the last one that parses.
function readRecords(dir) {
    if (!fs.existsSync(dir)) return [];

    const found = [];
    for (const name of fs.readdirSync(dir)) {
        if (!/\.(log|ldb)$/.test(name)) continue;

        const buf = fs.readFileSync(path.join(dir, name));

        // Walk the append log. A record header is crc32(4) | length(2) | type(1), and only type 1
        // carries a user payload; the rest are compaction bookkeeping.
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

    return null;
}

const records = readRecords(STORE);
if (records.length === 0) {
    console.log('No trail in storage yet.');
    console.log('The trail is written by the content script, so it appears after a page load runs the');
    console.log('current build. Reload the extension and open the detection page once.');
    process.exit(0);
}

// The last record that parses is the newest trail.
let newest = null;
for (const payload of records) {
    const parsed = extractTrails(payload);
    if (parsed) newest = parsed;
}

if (!newest) {
    console.log('Found trail records but none parsed. Raw tail of the newest one:');
    console.log(records[records.length - 1].slice(0, 600));
    process.exit(0);
}

for (const [tabId, run] of Object.entries(newest)) {
    console.log('');
    console.log('=== tab ' + tabId + ' (load began ' + (run.startedAt || 'unknown') + ') ===');

    let previous = null;
    for (const event of run.events || []) {
        const gap = previous ? '+' + (Date.parse(event.t) - Date.parse(previous)) + 'ms' : '';
        const detail = event.detail === null || event.detail === undefined
            ? ''
            : ' ' + JSON.stringify(event.detail);

        console.log(
            String(event.t).slice(11, 23).padEnd(13) +
            String(gap).padStart(9) + '  ' +
            String(event.name).padEnd(22) + detail);

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
