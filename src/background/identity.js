// Putting the page's chosen address on its own requests.
//
// The captcha ticket is bound to the address that fetched it, and the page fetches it over plain
// HTTPS, which the relay cannot touch. Without this the ticket is issued for the real address while
// the socket carries the synthetic one, and the server refuses the detection with "Invalid request".
//
// Every address the page names is validated first: the value is written into a request header, and
// a newline in it would let a caller inject arbitrary headers.

// Only the hosts involved in the detection and its captcha are touched. The rule is a header
// injection, so the narrower it is the less it can disturb.
export const IDENTITY_RULE_ID = 1;

export const IDENTITY_DOMAINS = Object.freeze([
    '||matrix.tencent.com',
    '||t.captcha.qq.com',
    '||captcha.gtimg.com'
]);

export function isIpv4(value) {
    if (typeof value !== 'string' || value.length > 15) return false;

    const parts = value.split('.');
    if (parts.length !== 4) return false;

    return parts.every(part => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

// Builds the rules for one address. One rule per domain keeps the conditions simple and the blast
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

export function buildIdentityRules(ip) {
    return IDENTITY_DOMAINS.map((filter, index) => ({
        id: IDENTITY_RULE_ID + index,
        priority: 1,
        action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'x-forwarded-for', operation: 'set', value: ip }]
        },
        condition: {
            urlFilter: filter,
            resourceTypes: COVERED_RESOURCE_TYPES
        }
    }));
}

// Updates and reads both answer through a callback whose failure arrives as lastError, which is
// only readable inside that callback. Wrapping them here keeps the error from being swallowed by
// the next async hop.
function updateDynamicRulesAsync(chrome, changes) {
    return new Promise((resolve, reject) => {
        try {
            chrome.declarativeNetRequest.updateDynamicRules(changes, () => {
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

function readDynamicRulesAsync(chrome) {
    return new Promise((resolve, reject) => {
        try {
            chrome.declarativeNetRequest.getDynamicRules(rules => {
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

// The address the installed rules actually carry, or null when the set is incomplete or mixed.
//
// Reading the rules back is the only way to know what the browser is using: a resolved update means
// it was accepted, not that these three rules with this value are now live.
export function addressFromRules(rules) {
    if (!Array.isArray(rules) || rules.length === 0) return null;

    const byId = new Map(rules.map(rule => [rule.id, rule]));
    let address = null;

    for (let index = 0; index < IDENTITY_DOMAINS.length; index += 1) {
        const rule = byId.get(IDENTITY_RULE_ID + index);
        if (!rule) return null;

        const headers = (rule.action && rule.action.requestHeaders) || [];
        const header = headers.find(entry => String(entry.header).toLowerCase() === 'x-forwarded-for');
        if (!header || header.operation !== 'set' || !isIpv4(header.value)) return null;

        if (address === null) address = header.value;
        else if (address !== header.value) return null;
    }

    return address;
}

export function createIdentityRules({ chrome, log = () => {} }) {
    // The address last confirmed to be on the live rules. Never written before that confirmation.
    let current = null;

    // Updates run one at a time. Two page loads publishing in quick succession would otherwise race,
    // and the earlier one can land last, leaving the rules on the address the older load picked.
    let queue = Promise.resolve();

    const identity = {
        // The address the rules were confirmed to carry, so the caller can skip a redundant update.
        get current() {
            return current;
        },

        // Always a promise: the caller has to be able to wait for confirmation, and a mixed return
        // type would make the synchronous refusals look like an unverified success.
        apply(ip) {
            if (!isIpv4(ip)) return Promise.resolve(false);
            if (ip === current) return Promise.resolve(true);

            const run = async () => {
                const rules = buildIdentityRules(ip);

                try {
                    await updateDynamicRulesAsync(chrome, {
                        removeRuleIds: rules.map(rule => rule.id),
                        addRules: rules
                    });
                } catch (error) {
                    // Nothing is rolled back: an update is atomic, so the previous set is still live
                    // and `current` still describes it.
                    log('identity rule failed: ' + (error.message || error));
                    return false;
                }

                let installed = null;
                try {
                    installed = addressFromRules(await readDynamicRulesAsync(chrome));
                } catch (error) {
                    log('identity rule unreadable: ' + (error.message || error));
                    return false;
                }

                if (installed !== ip) {
                    log('identity rule mismatch: wanted ' + ip + ', found ' + (installed || 'none'));
                    return false;
                }

                current = ip;
                return true;
            };

            const result = queue.then(run, run);
            // The queue itself must never reject, or every later update inherits the failure.
            queue = result.then(() => {}, () => {});
            return result;
        },

        // Rebuilds `current` from the rules the browser actually holds.
        //
        // A service worker restart erases this module's memory but not the persisted rules, so the
        // field would otherwise claim the rules carry nothing while they still carry the last
        // address - and the first load after the restart would skip a needed update.
        async sync() {
            try {
                current = addressFromRules(await readDynamicRulesAsync(chrome));
            } catch (error) {
                log('identity rule unreadable: ' + (error.message || error));
                current = null;
            }

            return current;
        }
    };

    return identity;
}
