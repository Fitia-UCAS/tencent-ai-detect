// Compares an external review patch against what this repository actually did.
//
// A review hands over suggestions in several shapes: a diff, a table of file/line findings, and
// prose recommendations. Diffing the patch alone answers only the first, and even that answer is
// easy to get wrong by eye once both sides have moved on. This script reconstructs the reviewed
// state from the base commit plus the patch, then answers three questions per file and per
// proposal:
//
//   * what did the patch change (mechanical, from the hunks)
//   * what does our HEAD have at that location (mechanical)
//   * did we take the proposal, take it further, or refuse it (asserted, not narrated)
//
// The third one is the part a plain diff cannot express, so each proposal carries probes: strings
// that must be present (or absent) in the reviewed code and in ours. A probe that fails is printed
// as a failure rather than quietly described as done - the report is only worth handing over if it
// can be wrong out loud.
//
//   node tools/compare-review.cjs --patch <file.diff> [--base <commit>] [--out <file.md>]
//
// The patch is applied in memory: the base content of each touched file is read from git, the
// hunks are replayed onto it, and nothing in the working tree is touched.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function git(args, options = {}) {
    return execFileSync('git', args, {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        ...options
    });
}

function arg(name, fallback) {
    const index = process.argv.indexOf('--' + name);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

// Where the patch probably is, so the common case needs no arguments.
function findPatch(explicit) {
    if (explicit) {
        if (!fs.existsSync(explicit)) throw new Error('patch not found: ' + explicit);
        return path.resolve(explicit);
    }

    const roots = [
        path.join(ROOT, 'review'),
        path.join(os.homedir(), 'Downloads'),
        path.join(os.homedir(), 'Desktop'),
        'D:/EdgeDownloads'
    ];

    const found = [];
    for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        for (const entry of fs.readdirSync(root)) {
            if (!/\.(diff|patch)$/i.test(entry)) continue;
            const full = path.join(root, entry);
            found.push({ full, at: fs.statSync(full).mtimeMs });
        }
    }

    if (!found.length) {
        throw new Error('no .diff/.patch found; pass --patch <file>');
    }

    found.sort((a, b) => b.at - a.at);
    return found[0].full;
}

// --- reading the patch --------------------------------------------------------

function parsePatch(text) {
    const files = [];
    let current = null;
    let hunk = null;

    for (const line of text.split(/\r?\n/)) {
        if (line.startsWith('diff --git ')) {
            const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
            if (!match) continue;
            current = { path: match[2], hunks: [], isNew: false };
            files.push(current);
            hunk = null;
            continue;
        }

        if (!current) continue;

        if (line.startsWith('new file mode')) {
            current.isNew = true;
            continue;
        }

        if (line.startsWith('deleted file mode')) {
            current.deleted = true;
            continue;
        }

        const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (header) {
            hunk = {
                oldStart: Number(header[1]),
                oldCount: header[2] === undefined ? 1 : Number(header[2]),
                newStart: Number(header[3]),
                newCount: header[4] === undefined ? 1 : Number(header[4]),
                lines: []
            };
            current.hunks.push(hunk);
            continue;
        }

        if (!hunk) continue;
        // Once the counts declared in the header are satisfied the hunk is over. Without this the
        // parser keeps consuming whatever follows - and in a multi-commit patch the trailer after a
        // hunk starts with "-- " and "---", lines that look like deletions, so they were absorbed
        // into the last hunk and made it fail validation against its own header.
        if (hunk.closed) continue;
        // A newline marker belongs to the previous line; a blank line is the end of the diff body.
        if (line.startsWith('\\') || line === '') continue;
        // The ending is dropped here too, so a body line and the base line it refers to compare
        // equal regardless of what the patch file used.
        if (line[0] === ' ' || line[0] === '+' || line[0] === '-') {
            hunk.lines.push(line.replace(/\r$/, ''));

            const oldSeen = hunk.lines.filter(entry => entry[0] === ' ' || entry[0] === '-').length;
            const newSeen = hunk.lines.filter(entry => entry[0] === ' ' || entry[0] === '+').length;
            if (oldSeen >= hunk.oldCount && newSeen >= hunk.newCount) hunk.closed = true;
        }
    }

    return files;
}

// Replays the hunks onto the base lines. Returns the reconstructed text and a count of context
// lines that did not match, which would mean the patch was cut against a different base.
function applyHunks(baseLines, hunks) {
    const out = [];
    let cursor = 0;
    let drift = 0;
    const errors = [];

    for (const hunk of hunks) {
        const oldSeen = hunk.lines.filter(line => line[0] === ' ' || line[0] === '-').length;
        const newSeen = hunk.lines.filter(line => line[0] === ' ' || line[0] === '+').length;

        if (oldSeen !== hunk.oldCount || newSeen !== hunk.newCount) {
            errors.push(
                `hunk -${hunk.oldStart},+${hunk.newStart}: header declares ${hunk.oldCount}/${hunk.newCount} lines, ` +
                `body contains ${oldSeen}/${newSeen}`
            );
        }

        // For a zero-length old range, oldStart is the number of lines before the insertion.
        // For a non-empty range, unified diff line numbers are one-based.
        const start = hunk.oldCount === 0 ? hunk.oldStart : Math.max(0, hunk.oldStart - 1);

        if (start < cursor) {
            errors.push(`hunk -${hunk.oldStart},+${hunk.newStart}: hunks overlap or are out of order`);
        }
        if (start > baseLines.length) {
            errors.push(`hunk -${hunk.oldStart},+${hunk.newStart}: old range starts beyond end of base`);
        }

        while (cursor < start && cursor < baseLines.length) out.push(baseLines[cursor++]);

        for (const line of hunk.lines) {
            const tag = line[0];
            const body = line.slice(1);

            if (tag === ' ') {
                if (cursor >= baseLines.length) {
                    errors.push(`hunk -${hunk.oldStart},+${hunk.newStart}: context extends beyond end of base`);
                    out.push(body);
                } else {
                    if (baseLines[cursor] !== body) drift += 1;
                    out.push(baseLines[cursor]);
                    cursor += 1;
                }
            } else if (tag === '-') {
                if (cursor >= baseLines.length) {
                    errors.push(`hunk -${hunk.oldStart},+${hunk.newStart}: deletion extends beyond end of base`);
                } else {
                    if (baseLines[cursor] !== body) drift += 1;
                    cursor += 1;
                }
            } else if (tag === '+') {
                out.push(body);
            }
        }
    }

    while (cursor < baseLines.length) out.push(baseLines[cursor++]);

    return { lines: out, drift, errors };
}

// Trailing CR is dropped: this tool compares content. The repo stores bytes exactly
// (gitattributes `* -text`), and a patch may carry CRLF on some lines and not others, so keeping
// the endings would report drift on every context line and bury the actual difference.
function splitLines(text) {
    return text.split('\n').map(line => line.replace(/\r$/, ''));
}

function readAt(commit, file) {
    try {
        return splitLines(git(['show', commit + ':' + file], { stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch (error) {
        return null;
    }
}

function readWorking(file) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) return null;
    // A proposal may name a directory (tests/unit/), which has no text of its own.
    if (!fs.statSync(full).isFile()) return null;
    return splitLines(fs.readFileSync(full, 'utf8'));
}

// Trailing blank lines are a difference in how the file ends, not in what it says. Comparing on the
// normalised form keeps a missing final newline from reporting a whole file as diverged.
function normalize(lines) {
    if (!lines) return lines;
    let end = lines.length;
    while (end > 0 && lines[end - 1] === '') end -= 1;
    return lines.slice(0, end);
}

function sameLines(a, b) {
    if (!a || !b) return a === b;
    const left = normalize(a);
    const right = normalize(b);
    if (left.length !== right.length) return false;
    return left.every((line, index) => line === right[index]);
}

function countChanged(before, after) {
    if (!after) return { added: 0, removed: 0 };
    if (!before) return { added: normalize(after).length, removed: 0 };

    before = normalize(before);

    // A cheap LCS would be overkill here: the numbers only need to say how much moved.
    const beforeSet = new Map();
    for (const line of before) beforeSet.set(line, (beforeSet.get(line) || 0) + 1);

    let added = 0;
    for (const line of normalize(after)) {
        const left = beforeSet.get(line) || 0;
        if (left > 0) beforeSet.set(line, left - 1);
        else added += 1;
    }

    let removed = 0;
    for (const count of beforeSet.values()) removed += count;

    return { added, removed };
}

function unified(before, after, file) {
    if (sameLines(before, after)) return '';

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-'));
    const left = path.join(dir, 'a.txt');
    const right = path.join(dir, 'b.txt');
    fs.writeFileSync(left, (before || []).join('\n'));
    fs.writeFileSync(right, (after || []).join('\n'));

    let text = '';
    try {
        text = execFileSync('git', ['diff', '--no-index', '--no-color', '-U2', '--', left, right], {
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024
        });
    } catch (error) {
        // git diff --no-index exits 1 when the files differ; the output is still on stdout.
        text = String(error.stdout || '');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    // git names the files after the temp copies, and on Windows it quotes and escapes those paths.
    // Only the hunks are useful here, so the header is rebuilt with names that mean something.
    const body = text.split('\n').filter(line => !/^(diff --git |index |--- |\+\+\+ )/.test(line));

    return ['--- review/' + file, '+++ ours/' + file, ...body].join('\n');
}

// --- the proposals ------------------------------------------------------------
//
// One entry per recommendation the review made. `probe` describes what must be true in a given
// text for the claim to hold, so the table below is checked rather than asserted.
//
// verdict:
//   adopted             took it as offered
//   extended            took it and went further
//   rejected            declined, with the reason recorded
//   open                agreed with it but have not done it yet
const PROPOSALS = [
    {
        id: 'P0-1',
        file: 'src/content/index.js',
        topic: 'observe the document, not documentElement',
        verdict: 'adopted',
        claim: 'The review found this and I had not: document_start can run before <html> exists, observe() then throws, and the rest of initialisation never runs. Taken as offered.',
        probe: { must: [/observer\.observe\(document,/] }
    },
    {
        id: 'P0-2',
        file: 'src/content/auto.js',
        topic: 'restoreDraft must not delete the backup before the editor accepts it',
        verdict: 'adopted',
        claim: 'The old order was removeItem then writeEditor, so when the editor had not rendered yet the write returned false but the only copy of the draft was already gone. One rotation ate the text. Taken as offered.',
        probe: { must: [/if \(!ZQ\.writeEditor\(text\)\) return false;/] }
    },
    {
        id: 'P0-3',
        file: 'src/content/auto.js',
        topic: 'once the editor has content, never revive the old draft during that load',
        verdict: 'adopted',
        claim: 'A later timer could still write the old draft back after the user cleared what they had just typed. There was no such guard. Taken as offered.',
        probe: { must: [/draftRestoreConflict/] }
    },
    {
        id: 'P0-4',
        file: 'src/content/auto.js',
        topic: 'saveDraft stores the raw text, not the trimmed readEditor()',
        verdict: 'adopted',
        claim: 'readEditor() trims, so the stored draft lost its leading and trailing whitespace. Taken as offered.',
        probe: { must: [/editor \? \(editor\.textContent \|\| ''\) : ''/] }
    },
    {
        id: 'P1-1',
        file: 'src/background/identity.js',
        topic: 'apply() reported success before updateDynamicRules finished',
        verdict: 'extended',
        claim: 'The review rated this high and then left it out of its own suggestion table. Finished here: the reply waits for getDynamicRules() to read the three rules back and check they carry the same address, updates are serialized so a slow early one cannot overwrite a later one, and sync() rebuilds state from the rules the browser actually holds after a worker restart. sync() later joined the same queue, and rule calls carry a timeout so one call that never answers cannot block the queue forever.',
        probe: { must: [/addressFromRules/, /updateDynamicRulesAsync/, /enqueue/, /withTimeout/] }
    },
    {
        id: 'P1-2',
        file: 'src/background/messages.js',
        topic: 'setIdentity must not answer success for an update it never verified',
        verdict: 'extended',
        claim: 'The handler could return success before the update finished. It now waits for the read-back and answers ignored or error on failure, never success.',
        probe: { must: [/\.then\(applied =>/] }
    },
    {
        id: 'P1-3',
        file: 'src/content/auto.js',
        topic: 'a refused rule should stop the click, not just log',
        verdict: 'extended',
        claim: 'Not raised by the review, but the direct consequence of P1-2: identity.js now records whether the background confirmed the rule, and autoDetect() refuses to click when it was refused, because that address pairing is rejected every time and pressing only burns an address. Unconfirmed does not block, or a slow install would stall the automation for good.',
        probe: { must: [/identityConfirmed === false/] }
    },
    {
        id: 'P1-4',
        file: 'src/content/auto.js',
        topic: 'a press is an attempt, not a finished detection',
        verdict: 'extended',
        claim: 'The old record stored the text itself, which claimed a detection that had only been a click. It now stores what was observed: submitted-unconfirmed, quota-decrement-observed, blocked, or unknown, with the quota snapshot taken at the press. None of those states allows an automatic re-press. A later round renamed completed to quota-decrement-observed, because a counter drop cannot be attributed to this request.',
        probe: { must: [/submitted-unconfirmed/, /attemptState/, /q: currentQuota\(\)/] }
    },
    {
        id: 'P1-5',
        file: 'src/content/auto.js',
        topic: 'fingerprint() should normalize only newlines and nbsp',
        verdict: 'rejected',
        claim: 'Rejected. A measured re-render turns a newline into space + CRLF + space; normalizing only the newline leaves the indentation spaces, the two fingerprints still differ, and the draft is pressed again with no ticket. Stripping all whitespace covers the measured shape, and collapsing "a b" with "ab" merely means one duplicate is missed. The review withdrew this one later.',
        probe: { must: [/replace\(\/[^a-zA-Z]s\+/], mustNot: [/\u00a0/] }
    },
    {
        id: 'P1-6',
        file: 'src/background/identity.js',
        topic: 'the COVERED_RESOURCE_TYPES comment claimed to cover everything but main_frame',
        verdict: 'adopted',
        claim: 'Took the narrower half it suggested: the comment now says the list covers the resource types this flow uses and no longer claims to be exhaustive. webtransport and webbundle were not added, because nothing here uses those protocols and adding them would widen the blast radius for no gain.',
        probe: { must: [/webtransport and webbundle are also absent/] }
    },
    {
        id: 'P1-7',
        file: 'src/shim/index.js',
        topic: 'silently falling back to the original address hid the transport failure',
        verdict: 'extended',
        claim: 'Delivered in the review pack: _fallback() is gone, and a relay failure before open goes through _failRelay() then _fail(), emitting one terminal error and close instead of switching to the origin. Added the loop that closes it off: after failing closed the page holds a dead socket and never opens another, so the shim announces zq:relay-failed. A relay that is really down goes to the rotation path; a relay that answers gets one reload per load and then only reporting, so a persistent socket fault cannot become a reload loop.',
        probe: { must: [/_failRelay\(\)/, /zq:relay-failed/] }
    },
    {
        id: 'P1-7b',
        file: 'src/content/engine.js',
        topic: 'failing closed needs a recovery path, or the page sits on a dead socket',
        verdict: 'extended',
        claim: 'Not raised by the review, but the direct consequence of P1-7. Removing the fallback was right, but the page never reopens the socket, so it stays dead even after the relay returns. engine.js now listens for zq:relay-failed: a relay that is down goes to the rotation path, a relay that is up gets one reload per load and then only reporting.',
        probe: { must: [/handleTransportFailure/, /transportRetried/] }
    },
    {
        id: 'P1-8',
        file: 'src/content/engine.js',
        topic: 'stop the run when the allowance is exhausted instead of rotating',
        verdict: 'rejected',
        claim: 'Rejected for this project. Rotating is the requested behaviour: this extension exists to keep the allowance usable without the user pressing anything. The suggested alternative suits ordinary automation, not this one.',
        probe: { must: [/ZQ\.rotate\(reason\);/] }
    },
    {
        id: 'P1-9',
        file: 'src/background/identity.js',
        topic: 'the three dynamic rules are global and not isolated per tab',
        verdict: 'open',
        claim: 'Agreed. The rules carry no tab condition, and two detection pages overwrite the address each other wrote. Code unchanged: this extension is used with one detection tab, and per-tab rules would need sessionRuleIds plus tab lifecycle cleanup. The limitation itself is stated in the delivery note, with what multi-tab support would require: updateSessionRules, tabIds, and tracking tab lifecycle.',
        probe: { must: [/IDENTITY_RULE_ID/], mustNot: [/tabIds/] }
    },
    {
        id: 'P2-1',
        file: 'tests/unit/',
        topic: 'add regressions for a DOM that is not ready, storage failure, duplicate submission, two tabs',
        verdict: 'extended',
        claim: 'Three of the four are covered: test-document-start.cjs, test-draft-safety.cjs (nine storage and write failure cases), and the submission state cases in test-auto-detect.cjs. Two tabs remain uncovered, consistent with P1-9.',
        probe: { files: ['tests/unit/test-document-start.cjs', 'tests/unit/test-draft-safety.cjs'] }
    },
    {
        id: 'P1-10',
        file: 'src/content/engine.js',
        topic: 'the cross-load reload budget breaks when storage reads or writes fail',
        verdict: 'extended',
        claim: 'The review found this and fixed the failure paths: unreadable, unpersisted, corrupt, and future-dated records all fail closed. But the budget still lived in the site origin storage, which the page itself can clear, so the extension-controlled half of the requirement was not met. Moved to extension storage, with the same fail-closed behaviour on a failed read, a failed write, and a read-back that does not match.',
        probe: { must: [/chrome\.storage\.local/, /validBudget/, /recordTransportReload/], mustNot: [/localStorage\.setItem\(ZQ\.TRANSPORT_RELOAD_KEY/] }
    },
    {
        id: 'P1-11',
        file: 'src/content/auto.js',
        topic: 'a counter drop does not prove this detection completed',
        verdict: 'adopted',
        claim: 'The judgement holds: a drop in the displayed allowance cannot be attributed to this request, and without a request id there is no causal link. That criterion was mine and it does not hold up. Renamed to quota-decrement-observed, legacy records are read as an observation, and the duplicate-submission guard is unchanged.',
        probe: { must: [/quota-decrement-observed/], mustNot: [/settled = 'completed'/] }
    },
    {
        id: 'P1-12',
        file: 'src/content/engine.js',
        topic: 'whether the site SDK reconnects on its own, before adding a second recovery',
        verdict: 'extended',
        claim: 'The review asked for passive observation first. Measured with tools/diagnostics/diag-sdk-reconnect.cjs without touching the local relay: the page creates one socket on load, and after closing it no second socket appeared within 30 seconds, nor did the page reload itself. So there is no SDK reconnect to rely on, and the reload is the only recovery there is. Kept.',
        probe: { files: ['tools/diagnostics/diag-sdk-reconnect.cjs'] }
    },
    {
        id: 'P1-13',
        file: 'src/background/identity.js',
        topic: 'sync() and apply() were not serialized against each other',
        verdict: 'adopted',
        claim: 'The judgement holds: sync() read the rules outside the queue, so a worker restart completing after an apply would write the previous address back into current, and the next publish would skip an update that was needed. sync() now takes the same turn, and rule calls time out so one call that never answers cannot block the queue.',
        probe: { must: [/function enqueue/, /withTimeout/, /sync\(\) \{\s*return enqueue/] }
    }
];
function runProbe(proposal, text, fileSet) {
    const probe = proposal.probe || {};

    if (probe.files) {
        const missing = probe.files.filter(file => !fileSet.has(file));
        return missing.length ? 'missing file(s): ' + missing.join(', ') : null;
    }

    if (!text) return 'no such file';

    for (const pattern of probe.must || []) {
        if (!pattern.test(text)) return 'expected ' + pattern + ' in ' + proposal.file;
    }

    for (const pattern of probe.mustNot || []) {
        if (pattern.test(text)) return 'did not expect ' + pattern + ' in ' + proposal.file;
    }

    return null;
}

// A file probe compares two snapshots, not just the current disk. Checking fs.existsSync inside
// runProbe falsely gave the reviewed patch credit for files added only by our later commits.
function probeFileSets(proposals, patchFiles, existsAtBase, existsWorking) {
    const changes = new Map(patchFiles.map(file => [file.path, file]));
    const referenced = new Set(proposals.flatMap(proposal => (proposal.probe || {}).files || []));
    const theirs = new Set();
    const ours = new Set();

    for (const file of referenced) {
        const change = changes.get(file);
        if (change ? !change.deleted : existsAtBase(file)) theirs.add(file);
        if (existsWorking(file)) ours.add(file);
    }

    return { theirs, ours };
}

// The unresolved section must come from the same verdicts as the proposal table. Keeping a
// handwritten list here once made a completed shim fix appear as still open even while all probes
// passed. New or resolved proposals now update the section without a second manual edit.
function openIssueLines(proposals) {
    const open = proposals.filter(proposal => proposal.verdict === 'open');
    if (!open.length) return ['Nothing is marked agreed-but-not-done.'];

    return [
        `${open.length} item(s) are agreed but not done:`,
        '',
        ...open.map(proposal => `- ${proposal.id} \`${proposal.file}\`: ${proposal.topic}`)
    ];
}

// --- the report ---------------------------------------------------------------

function main() {
    const patchPath = findPatch(arg('patch'));
    const base = arg('base', '8e39d72');
    const head = git(['rev-parse', '--short', 'HEAD']).trim();
    const out = arg('out', path.join(os.homedir(), 'Desktop', 'tencent-ai-detect-review-comparison.md'));

    const patchFiles = parsePatch(fs.readFileSync(patchPath, 'utf8'));
    if (!patchFiles.length) throw new Error('the patch has no file sections: ' + patchPath);

    // Their state: the base content with their hunks replayed onto it.
    const theirs = new Map();
    let drift = 0;
    const hunkErrors = [];
    for (const file of patchFiles) {
        const baseLines = file.isNew ? [] : readAt(base, file.path);
        if (baseLines === null) {
            theirs.set(file.path, { lines: null, error: 'not in ' + base });
            continue;
        }
        const applied = applyHunks(baseLines, file.hunks);
        drift += applied.drift;
        for (const error of applied.errors) hunkErrors.push(file.path + ': ' + error);
        theirs.set(file.path, { lines: applied.lines, baseLines });
    }

    const ours = new Map();
    const fileSet = new Set();
    for (const file of patchFiles) {
        const lines = readWorking(file.path);
        ours.set(file.path, lines);
        if (lines) fileSet.add(file.path);
    }

    // Files we changed that the patch never mentioned, so the table shows both directions.
    const changedByUs = git(['diff', '--name-only', base + '..HEAD']).split('\n').filter(Boolean);

    const rows = [];
    for (const file of patchFiles) {
        const baseLines = theirs.get(file.path).baseLines || null;
        const theirLines = theirs.get(file.path).lines;
        const ourLines = ours.get(file.path);

        const theirChange = countChanged(baseLines, theirLines);
        const ourChange = countChanged(baseLines, ourLines);

        let state;
        if (sameLines(theirLines, ourLines)) state = 'identical';
        else if (sameLines(ourLines, baseLines)) state = 'not applied';
        else if (sameLines(theirLines, baseLines)) state = 'we only';
        else state = 'diverged';

        rows.push({ file: file.path, state, theirChange, ourChange, baseLines, theirLines, ourLines });
    }

    const extra = changedByUs.filter(file => !theirs.has(file));

    const { theirs: theirFiles, ours: ourFiles } = probeFileSets(
        PROPOSALS, patchFiles,
        file => readAt(base, file) !== null,
        file => fs.existsSync(path.join(ROOT, file))
    );

    const probeResults = PROPOSALS.map(proposal => {
        // Probes may point at files the patch never touched: the review's findings were spread over
        // the whole worker, while its patch only carried four files.
        const ourCache = new Map();
        function workingText(file) {
            if (!ourCache.has(file)) ourCache.set(file, readWorking(file) ? readWorking(file).join('\n') : null);
            return ourCache.get(file);
        }

        const theirText = proposal.probe && proposal.probe.files
            ? null
            : (theirs.has(proposal.file) && theirs.get(proposal.file).lines
                ? theirs.get(proposal.file).lines.join('\n')
                : readAt(base, proposal.file) ? readAt(base, proposal.file).join('\n') : null);
        const ourText = proposal.probe && proposal.probe.files ? null : workingText(proposal.file);

        return {
            proposal,
            theirFailure: runProbe(proposal, theirText, theirFiles),
            ourFailure: runProbe(proposal, ourText, ourFiles)
        };
    });

    const commits = git(['log', '--oneline', base + '..HEAD']).split('\n').filter(Boolean);

    const md = [];
    md.push('# External review vs what this repository did');
    md.push('');
    md.push('Generated by `tools/compare-review.cjs` and safe to re-run: it reads the base commit, replays each hunk of the external patch in memory to reconstruct what the review produced, then compares that against the working tree, per file and per proposal. The working tree is never modified.');
    md.push('');
    md.push('| Field | Value |');
    md.push('|---|---|');
    md.push('| Base the patch was cut against | `' + base + '` |');
    md.push('| Patch file | `' + path.basename(patchPath) + '` |');
    md.push('| Current HEAD | `' + head + '` |');
    md.push('| Files in the patch | ' + patchFiles.length + ' |');
    md.push('| Files we changed that the patch never mentions | ' + extra.length + ' |');
    md.push('| Lines of context that did not match while replaying | ' + drift + (drift ? ' (the patch may not be cut against this base)' : ' (patch matches the base)') + ' |');
    md.push('| Hunk structure errors | ' + hunkErrors.length + ' |');
    md.push('');

    if (hunkErrors.length) {
        md.push('### Hunk structure validation failed');
        md.push('');
        for (const error of hunkErrors) md.push('- ' + error);
        md.push('');
    }

    md.push('## 1. Per-file comparison');
    md.push('');
    md.push('`identical` = both sides produced the same content; `diverged` = both changed the file with different results; `not applied` = only the review changed it; `we only` = only this repository changed it.');
    md.push('');
    md.push('| File | State | Review +/- | Ours +/- |');
    md.push('|---|---|---:|---:|');
    for (const row of rows) {
        md.push('| `' + row.file + '` | ' + row.state + ' | +' + row.theirChange.added + ' / -' + row.theirChange.removed +
            ' | +' + row.ourChange.added + ' / -' + row.ourChange.removed + ' |');
    }
    md.push('');

    if (extra.length) {
        md.push('Files this repository changed that the patch never touches:');
        md.push('');
        for (const file of extra) md.push('- `' + file + '`');
        md.push('');
    }

    md.push('## 2. Verdict per proposal');
    md.push('');
    md.push('Every verdict carries a probe, run against both the reconstructed review state and this repository. A failing probe is printed rather than described away, so the table can be shown to be wrong instead of merely asserted.');
    md.push('');
    const label = {
        adopted: 'adopted',
        extended: 'adopted, taken further',
        rejected: 'rejected',
        open: 'agreed, not done'
    };
    md.push('| # | File | Proposal | Verdict | Our code passes probe | Review patch passes probe |');
    md.push('|---|---|---|---|---|---|');
    for (const result of probeResults) {
        const p = result.proposal;
        md.push('| ' + p.id + ' | `' + p.file + '` | ' + p.topic + ' | ' + label[p.verdict] +
            ' | ' + (result.ourFailure ? 'FAIL - ' + result.ourFailure : 'PASS') +
            ' | ' + (result.theirFailure ? 'not included (' + result.theirFailure + ')' : 'PASS') + ' |');
    }
    md.push('');

    md.push('## 3. Reasoning per proposal');
    md.push('');
    for (const result of probeResults) {
        const p = result.proposal;
        md.push('### ' + p.id + ' - ' + p.topic);
        md.push('');
        md.push('Verdict: **' + label[p.verdict] + '**');
        md.push('');
        md.push(p.claim);
        md.push('');
    }

    const failures = probeResults.filter(result => result.ourFailure);
    md.push('## 4. Probe results against our own code');
    md.push('');
    if (failures.length) {
        md.push(failures.length + ' probe(s) did not pass, which means this table and the code disagree. Fix the code or fix the table before handing this over:');
        md.push('');
        for (const result of failures) {
            md.push('- ' + result.proposal.id + ' `' + result.proposal.file + '`: ' + result.ourFailure);
        }
    } else {
        md.push('All ' + probeResults.length + ' probes pass: every claim in this report about what we did has a corresponding construct in the code.');
    }
    md.push('');

    md.push('## 5. Still unresolved');
    md.push('');
    md.push(...openIssueLines(PROPOSALS));
    md.push('');

    md.push('## 6. Actual differences for every file that diverged');
    md.push('');
    md.push('Left is the review patch applied; right is this repository as it stands.');
    md.push('');
    for (const row of rows) {
        if (row.state === 'identical') continue;
        md.push('### `' + row.file + '` - ' + row.state);
        md.push('');
        const diff = unified(row.theirLines, row.ourLines, row.file);
        if (!diff.trim()) {
            md.push('(no difference)');
        } else {
            md.push('```diff');
            md.push(diff.trimEnd());
            md.push('```');
        }
        md.push('');
    }

    if (commits.length) {
        md.push('## 7. Commits after the base');
        md.push('');
        md.push('```');
        for (const line of commits) md.push(line);
        md.push('```');
        md.push('');
    }

    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, md.join('\n'), 'utf8');

    console.log('base      ', base);
    console.log('head      ', head);
    console.log('patch     ', patchPath);
    console.log('files     ', patchFiles.length, 'in patch,', extra.length, 'changed by us only');
    console.log('proposals ', probeResults.length - failures.length, '/', probeResults.length, 'probes pass');
    console.log('report    ', out);

    if (failures.length || hunkErrors.length) {
        for (const result of failures) {
            console.error('  FAIL ' + result.proposal.id + ': ' + result.ourFailure);
        }
        for (const error of hunkErrors) console.error('  HUNK FAIL ' + error);
        process.exitCode = 1;
    }
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error('compare failed: ' + (error && error.message ? error.message : error));
        process.exitCode = 1;
    }
}

module.exports = { parsePatch, applyHunks, openIssueLines, runProbe, probeFileSets };
