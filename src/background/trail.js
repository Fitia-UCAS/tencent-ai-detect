// An event trail for one detection, kept because the steps are not a fixed sequence.
//
// Every diagnosis in this project has been undone by the same mistake: assuming the page reaches a
// step. The challenge appears for some presses and not others; the result sometimes lands and
// sometimes is replaced; the address rule installs late or not at all. A guard that waits for a step
// which never came, and a guard that waits for one that already passed, look identical from outside -
// both do nothing, and the page says the same word either way.
//
// So the trail records what happened, in order, with the gap since the previous event. Reading it
// answers the questions that wording cannot: did the challenge come up, how long was it up, was the
// result already on screen when something else acted, and which step was missing entirely.
//
// Events are appended by the content script as they occur and ring-buffered here so a page reload
// does not erase the run that caused the problem. The key is per tab, because two tabs are two
// independent runs and interleaving them makes both unreadable.

// A whole diagnosis run is what has to fit, not a sample of it: the frames are now recorded in full,
// and a report frame or a ticket is a few hundred bytes. 80 entries could hold one exchange on a good
// day and lost the beginning of the story on a bad one.
const TRAIL_LIMIT = 400;

function nowIso() {
    return new Date().toISOString();
}

export function createTrail({ chrome, key = 'zqTrail' }) {
    // tabId -> { startedAt, events: [{ t, dt, name, detail }] }
    const runs = new Map();

    function readAll() {
        return new Promise(resolve => {
            try {
                chrome.storage.local.get([key], held => {
                    resolve((held && held[key]) || {});
                });
            } catch (e) {
                resolve({});
            }
        });
    }

    function writeAll(all) {
        try {
            chrome.storage.local.set({ [key]: all });
        } catch (e) {
            // A trail that cannot be stored must not break the page it is describing.
        }
    }

    function runFor(tabId) {
        const id = Number.isInteger(tabId) ? tabId : 'none';
        if (!runs.has(id)) {
            runs.set(id, { startedAt: nowIso(), events: [] });
        }
        return runs.get(id);
    }

    // Records one step. `name` is short and stable; `detail` is whatever helps explain it. The gap
    // from the previous event is stored rather than recomputed, because that interval is the thing
    // that distinguishes "the guard waited" from "the guard never ran".
    function add(tabId, name, detail, page) {
        const run = runFor(tabId);
        const last = run.events[run.events.length - 1];
        const entry = {
            t: nowIso(),
            dt: last ? Date.now() - Date.parse(last.t) : null,
            name: String(name),
            detail: detail === undefined ? null : detail
        };

        // The page picture is stored only when one was taken: repeating an identical snapshot on every
        // event would bury the transitions the trail exists to show.
        if (page) entry.page = page;

        run.events.push(entry);
        if (run.events.length > TRAIL_LIMIT) run.events.splice(0, run.events.length - TRAIL_LIMIT);

        const id = Number.isInteger(tabId) ? tabId : 'none';
        readAll().then(all => {
            all[id] = { startedAt: run.startedAt, events: run.events };
            writeAll(all);
        });

        return entry;
    }

    // Starts a new run for the tab. Called when a page begins, so a reload is visibly a boundary in
    // the trail rather than a jump in the timestamps.
    function reset(tabId) {
        const id = Number.isInteger(tabId) ? tabId : 'none';
        runs.set(id, { startedAt: nowIso(), events: [] });

        return readAll().then(all => {
            all[id] = { startedAt: nowIso(), events: [] };
            writeAll(all);
            return id;
        });
    }

    function read(tabId) {
        const id = Number.isInteger(tabId) ? tabId : 'none';
        return readAll().then(all => all[id] || null);
    }

    function clear(tabId) {
        if (Number.isInteger(tabId)) runs.delete(tabId);

        return readAll().then(all => {
            if (Number.isInteger(tabId)) delete all[tabId];
            else Object.keys(all).forEach(k => delete all[k]);
            writeAll(all);
        });
    }

    return { add, reset, read, clear };
}
