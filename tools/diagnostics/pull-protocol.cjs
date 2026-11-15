// Pulls the protocol facts straight out of the extension's LevelDB.
//
// The trail reader parses the structured trail, but that parsing has to survive LevelDB's block
// splitting and JSON escaping, and when it fails it fails silently - which is worse than useless
// while diagnosing. This reads the raw bytes and extracts only the pieces that answer the question:
// which tickets were sent, and what the server answered each time.
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

// The stored JSON is escaped, so both the quote and the backslash are preceded by a backslash.
const ESC = String.fromCharCode(92);

function occurrences(needle) {
    let count = 0;
    let at = 0;
    while (true) {
        const found = text.indexOf(needle, at);
        if (found === -1) return count;
        count += 1;
        at = found + needle.length;
    }
}

function extractAfter(prefix, minLength) {
    const found = [];
    let at = 0;
    while (true) {
        const idx = text.indexOf(prefix, at);
        if (idx === -1) break;
        at = idx + prefix.length;

        let end = at;
        while (end < text.length && text[end] !== '"' && text[end] !== ESC) end += 1;

        const value = text.slice(at, end);
        if (value.length >= minLength) found.push(value);
    }
    return found;
}

console.log('store size:', text.length);

const tickets = extractAfter(ESC + '"ticket' + ESC + '":' + ESC + '"', 20);
const uniqueTickets = new Set(tickets);
console.log('tickets sent: total', tickets.length, '| unique', uniqueTickets.size);

// Verdicts: the server's code field, escaped once more inside the body string.
const codes = extractAfter(ESC + '\\"code\\": \\"', 1);
const tally = {};
for (const code of codes) tally[code] = (tally[code] || 0) + 1;
console.log('server codes:', JSON.stringify(tally));

const statuses = extractAfter(ESC + '\\"status\\": \\"', 3);
const statusTally = {};
for (const status of statuses) statusTally[status] = (statusTally[status] || 0) + 1;
console.log('server statuses:', JSON.stringify(statusTally));

console.log('Invalid request occurrences:', occurrences('Invalid request'));

// A reused ticket is the failure this is meant to expose: the same string sent twice means the
// handshake was retried with a ticket that was already spent.
if (uniqueTickets.size > 0 && tickets.length > uniqueTickets.size) {
    const seen = new Map();
    for (const ticket of tickets) seen.set(ticket, (seen.get(ticket) || 0) + 1);

    const repeated = [...seen.entries()].filter(([, count]) => count > 1);
    console.log('tickets sent more than once:', repeated.length);
    for (const [ticket, count] of repeated.slice(0, 5)) {
        console.log('  x' + count, ticket.slice(0, 40) + '...');
    }
} else {
    console.log('no ticket was sent twice');
}
