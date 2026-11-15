// Putting the page's chosen address on its own requests.
//
// The captcha ticket is bound to the address that fetched it, and the page fetches it over plain
// HTTPS, which the relay cannot touch. Without this the ticket is issued for the real address while
// the socket carries the synthetic one, and the server refuses the detection with "Invalid request".
//
// Every address the page names is validated first: the value is written into a request header, and
// a newline in it would let a caller inject arbitrary headers.
//
// The rules are per tab, and that is not cosmetic. They used to be one global set carrying whichever
// load published last, which meant a second tab to the same site silently took the rules away from
// the first: the first tab's page kept its own address in memory, so its next publish put that stale
// address back on the rules while the other tab's socket carried the newer one, and one of the two
// tickets was refused. Measured: tab A held 47.96.186.107 while the rules and localStorage had
// already moved to 39.156.142.131.
//
// Per-tab conditions are only accepted in the session ruleset - a dynamic rule that names tabIds is
// rejected with "These are only supported for session-scoped rules", measured against Edge. Session
// rules are still owned by the browser rather than by this worker, so they survive a worker restart,
// and they are dropped when the browser exits, which costs nothing: every page load publishes again.

// Only the hosts involved in the detection and its captcha are touched. The rule is a header
// injection, so the narrower it is the less it can disturb.
export const IDENTITY_RULE_ID = 1;

export const IDENTITY_DOMAINS = Object.freeze([
    '||matrix.tencent.com',
    '||t.captcha.qq.com',
    '||captcha.gtimg.com'
]);

// One slot is one tab's worth of rules: one rule per domain. Slots keep rule ids predictable, so a
// tab's rules can be removed without tracking ids separately from the slot that owns them.
const RULES_PER_SLOT = IDENTITY_DOMAINS.length;

// 64 tabs is 192 session rules, far below the ruleset limit, and a slot is only held while its tab
// exists. A load that cannot get a slot is refused rather than served by a shared rule.
const MAX_SLOTS = 64;

export function isIpv4(value) {
    if (typeof value !== 'string' || value.length > 15) return false;

    const parts = value.split('.');
    if (parts.length !== 4) return false;

    return parts.every(part => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

export function slotRuleIds(slot) {
    const first = IDENTITY_RULE_ID + slot * RULES_PER_SLOT;
    return IDENTITY_DOMAINS.map((_, index) => first + index);
}

// The slot a set of rule ids belongs to, or null when the ids are not exactly one slot's worth.
export function slotFromRuleIds(ids) {
    if (!Array.isArray(ids) || ids.length !== RULES_PER_SLOT) return null;

    const ordered = ids.slice().sort((a, b) => a - b);
    const first = ordered[0];
    if (first < IDENTITY_RULE_ID) return null;
    if ((first - IDENTITY_RULE_ID) % RULES_PER_SLOT !== 0) return null;

    const slot = (first - IDENTITY_RULE_ID) / RULES_PER_SLOT;
    if (slot >= MAX_SLOTS) return null;

    const expected = slotRuleIds(slot);
    return ordered.every((id, index) => id === expected[index]) ? slot : null;
}

// Builds the rules for one tab. One rule per domain keeps the conditions simple and the blast
// radius visible.
//
// Covers the resource types the detection, its captcha and its socket actually use. The narrow
// list this used to carry (xmlhttprequest, websocket, sub_frame, other) silently skipped the
// captcha SDK's own script and image loads, so those requests left on the real address while the
// socket carried the synthetic one - and a ticket issued to one address is refused on the other.
//
// main_frame is left out on purpose: rewriting the header of the document itself is a much wider
// change than the detection needs. webtransport and webbundle are also absent - they are Chromium
// resource types, but nothing in this flow uses those protocols, and a rule that changes headers on
// them would widen the blast radius for no gain.
const COVERED_RESOURCE_TYPES = [
    'sub_frame',
    'stylesheet',
    'script',
    'image',
    'font',
    'object',
    'xmlhttprequest',
    'ping',
    'csp_report',
    'media',
    'websocket',
    'other'
];

export function buildIdentityRules(ip, tabId, slot) {
    const ids = slotRuleIds(slot);

    return IDENTITY_DOMAINS.map((filter, index) => ({
        id: ids[index],
        priority: 1,
        action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'x-forwarded-for', operation: 'set', value: ip }]
        },
        condition: {
            urlFilter: filter,
            resourceTypes: COVERED_RESOURCE_TYPES,
            tabIds: [tabId]
        }
    }));
}

// Updates and reads both answer through a callback whose failure arrives as lastError, which is
// only readable inside that callback. Wrapping them here keeps the error from being swallowed by
// the next async hop.
function updateSessionRulesAsync(chrome, changes) {
    return new Promise((resolve, reject) => {
        try {
            chrome.declarativeNetRequest.updateSessionRules(changes, () => {
                const error = chrome.runtime.lastError;
                if (error) {
                    reject(new Error(error.message || String(error)));
                    return;
                }
                resolve();
            });
        } catch (error) {
            reject(error);
        }
    });
}

function readSessionRulesAsync(chrome) {
    return new Promise((resolve, reject) => {
        try {
            chrome.declarativeNetRequest.getSessionRules(rules => {
                const error = chrome.runtime.lastError;
                if (error) {
                    reject(new Error(error.message || String(error)));
                    return;
                }
                resolve(rules || []);
            });
        } catch (error) {
            reject(error);
        }
    });
}

function queryTabsAsync(chrome) {
    return new Promise((resolve, reject) => {
        try {
            chrome.tabs.query({}, tabs => {
                const error = chrome.runtime.lastError;
                if (error) {
                    reject(new Error(error.message || String(error)));
                    return;
                }
                resolve(tabs || []);
            });
        } catch (error) {
            reject(error);
        }
    });
}

// The address the given rules carry, or null when they are incomplete or disagree.
//
// Reading the rules back is the only way to know what the browser is using: a resolved update means
// it was accepted, not that these rules with this value are now live.
export function addressFromRules(rules, ids) {
    if (!Array.isArray(rules) || rules.length === 0) return null;

    const wanted = ids || IDENTITY_DOMAINS.map((_, index) => IDENTITY_RULE_ID + index);
    const byId = new Map(rules.filter(rule => wanted.includes(rule.id)).map(rule => [rule.id, rule]));
    let address = null;

    for (const id of wanted) {
        const rule = byId.get(id);
        if (!rule) return null;

        const headers = (rule.action && rule.action.requestHeaders) || [];
        const header = headers.find(entry => String(entry.header).toLowerCase() === 'x-forwarded-for');
        if (!header || header.operation !== 'set' || !isIpv4(header.value)) return null;

        if (address === null) address = header.value;
        else if (address !== header.value) return null;
    }

    return address;
}

// Whether every one of these rules is scoped to the tab that asked for it.
//
// The address alone is not proof: a rule that lost its tabIds applies everywhere, which is the
// global behaviour this module exists to stop.
export function rulesCarryOnlyTab(rules, ids, tabId) {
    const byId = new Map((rules || []).map(rule => [rule.id, rule]));

    return ids.every(id => {
        const rule = byId.get(id);
        const tabIds = rule && rule.condition && rule.condition.tabIds;
        return Array.isArray(tabIds) && tabIds.length === 1 && tabIds[0] === tabId;
    });
}

// A rule call that never answers would otherwise leave its promise pending forever, and every later
// update would queue behind it - the extension would stop applying addresses entirely, with no error
// anywhere. Timing out is a failure, not a success: the address is not confirmed, so the state below
// is left alone and the caller has to treat the rule as unverified.
const RULE_OP_TIMEOUT_MS = 5000;

function withTimeout(promise, label, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(label + ' timed out after ' + timeoutMs + 'ms'));
        }, timeoutMs);

        promise.then(
            value => { clearTimeout(timer); resolve(value); },
            error => { clearTimeout(timer); reject(error); }
        );
    });
}

export function createHeaderRules({ chrome, log = () => {}, opTimeoutMs = RULE_OP_TIMEOUT_MS }) {
    // tabId -> { ip, slot }. Written only after the rules were read back and matched.
    const entries = new Map();
    // slot -> tabId, so a tab that reloads keeps its slot instead of taking another one.
    const slotOwners = new Map();

    // Rule operations run one at a time. Two page loads publishing in quick succession would
    // otherwise race, and the earlier one can land last, leaving a tab on the address the older
    // load picked. A sync racing an apply is the same defect from the other side: its read can
    // finish after the apply confirmed a newer address and put the stale one back.
    let queue = Promise.resolve();

    function enqueue(run) {
        const result = queue.then(run, run);
        // The queue itself must never reject, or every later operation inherits the failure.
        queue = result.then(() => {}, () => {});
        return result;
    }

    function takeSlot() {
        for (let slot = 0; slot < MAX_SLOTS; slot += 1) {
            if (!slotOwners.has(slot)) return slot;
        }

        return null;
    }

    async function removeRulesForSlot(slot) {
        try {
            await withTimeout(updateSessionRulesAsync(chrome, {
                removeRuleIds: slotRuleIds(slot)
            }), 'identity rule removal', opTimeoutMs);
            return true;
        } catch (error) {
            log('identity rule removal failed: ' + (error.message || error));
            return false;
        }
    }

    // Which tabs still exist, or null when the answer cannot be trusted. A null result means the
    // caller must not prune anything: dropping rules for tabs that are actually open would take the
    // address away from a page that is still working.
    async function aliveTabs() {
        if (!chrome.tabs || typeof chrome.tabs.query !== 'function') return null;

        try {
            const open = await withTimeout(queryTabsAsync(chrome), 'tab list', opTimeoutMs);
            return new Set((open || []).map(tab => tab.id));
        } catch (error) {
            log('tab list unreadable: ' + (error.message || error));
            return null;
        }
    }

    const identity = {
        // The address confirmed for one tab, so the caller can skip a redundant update.
        currentFor(tabId) {
            const entry = entries.get(tabId);
            return entry ? entry.ip : null;
        },

        // How many tabs currently hold a confirmed address. Used by the panel and the tests.
        get size() {
            return entries.size;
        },

        // Always a promise: the caller has to be able to wait for confirmation, and a mixed return
        // type would make the synchronous refusals look like an unverified success.
        apply(ip, tabId) {
            if (!isIpv4(ip)) return Promise.resolve(false);
            // A message without a sender tab cannot be scoped to one, and an unscoped rule is the
            // failure this module is built to avoid.
            if (!Number.isInteger(tabId) || tabId < 0) return Promise.resolve(false);

            return enqueue(async () => {
                // Re-read inside the queued step: a sync or an earlier apply may have changed the
                // entry while this one was waiting its turn.
                const existing = entries.get(tabId);
                if (existing && existing.ip === ip) return true;

                const slot = existing ? existing.slot : takeSlot();
                if (slot === null) {
                    log('no identity slot left for tab ' + tabId);
                    return false;
                }

                const rules = buildIdentityRules(ip, tabId, slot);
                const ids = rules.map(rule => rule.id);

                try {
                    await withTimeout(updateSessionRulesAsync(chrome, {
                        removeRuleIds: ids,
                        addRules: rules
                    }), 'identity rule update', opTimeoutMs);
                } catch (error) {
                    // Nothing is rolled back: an update is atomic, so the previous set is still live
                    // and the entry still describes it.
                    log('identity rule failed: ' + (error.message || error));
                    return false;
                }

                let installed = null;
                let scoped = false;
                try {
                    const held = await withTimeout(
                        readSessionRulesAsync(chrome), 'identity rule read', opTimeoutMs);
                    installed = addressFromRules(held, ids);
                    scoped = rulesCarryOnlyTab(held, ids, tabId);
                } catch (error) {
                    log('identity rule unreadable: ' + (error.message || error));
                    return false;
                }

                if (installed !== ip) {
                    log('identity rule mismatch: wanted ' + ip + ', found ' + (installed || 'none'));
                    return false;
                }

                if (!scoped) {
                    log('identity rule lost its tab scope for ' + tabId);
                    return false;
                }

                entries.set(tabId, { ip, slot });
                slotOwners.set(slot, tabId);
                return true;
            });
        },

        // Frees the rules a closed tab owns. Without this a slot would stay held for the rest of the
        // browser session by a tab that no longer exists.
        removeTab(tabId) {
            if (!Number.isInteger(tabId) || tabId < 0) return Promise.resolve(false);

            return enqueue(async () => {
                const entry = entries.get(tabId);
                if (!entry) return true;

                if (!(await removeRulesForSlot(entry.slot))) return false;

                entries.delete(tabId);
                slotOwners.delete(entry.slot);
                return true;
            });
        },

        // Rebuilds the map from the rules the browser actually holds.
        //
        // A service worker restart erases this module's memory but not the session rules, so the map
        // would otherwise claim nothing is installed while the rules are still live - and the first
        // load after the restart would skip a needed update.
        sync() {
            return enqueue(async () => {
                entries.clear();
                slotOwners.clear();

                let held = [];
                try {
                    held = await withTimeout(
                        readSessionRulesAsync(chrome), 'identity rule read', opTimeoutMs);
                } catch (error) {
                    log('identity rule unreadable: ' + (error.message || error));
                    return 0;
                }

                // Grouped by the tab each rule names, so a stale global rule - one without tabIds -
                // is simply not adopted.
                const grouped = new Map();
                for (const rule of held) {
                    const tabIds = rule && rule.condition && rule.condition.tabIds;
                    if (!Array.isArray(tabIds) || tabIds.length !== 1) continue;
                    const tabId = tabIds[0];
                    if (!grouped.has(tabId)) grouped.set(tabId, []);
                    grouped.get(tabId).push(rule);
                }

                // Rules whose tab is gone are removed rather than adopted: they can never match
                // again, and they would hold their slot for the rest of the browser session.
                const alive = await aliveTabs();
                const staleRuleIds = [];

                for (const [tabId, rules] of Array.from(grouped.entries())) {
                    if (alive && !alive.has(tabId)) {
                        staleRuleIds.push(...rules.map(rule => rule.id));
                        grouped.delete(tabId);
                    }
                }

                if (staleRuleIds.length) {
                    try {
                        await withTimeout(updateSessionRulesAsync(chrome, {
                            removeRuleIds: staleRuleIds
                        }), 'stale rule removal', opTimeoutMs);
                    } catch (error) {
                        log('stale rule removal failed: ' + (error.message || error));
                    }
                }

                for (const [tabId, rules] of grouped) {
                    const slot = slotFromRuleIds(rules.map(rule => rule.id));
                    if (slot === null) continue;
                    if (entries.has(tabId) || slotOwners.has(slot)) continue;

                    const ip = addressFromRules(rules, slotRuleIds(slot));
                    if (!ip) continue;

                    entries.set(tabId, { ip, slot });
                    slotOwners.set(slot, tabId);
                }

                return entries.size;
            });
        }
    };

    return identity;
}
