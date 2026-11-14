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
            resourceTypes: ['xmlhttprequest', 'websocket', 'sub_frame', 'other']
        }
    }));
}

export function createIdentityRules({ chrome, log = () => {} }) {
    let current = null;

    return {
        // The address the rules currently carry, so the caller can skip a redundant update.
        get current() {
            return current;
        },

        apply(ip) {
            if (!isIpv4(ip)) return false;
            if (ip === current) return true;

            const rules = buildIdentityRules(ip);

            try {
                chrome.declarativeNetRequest.updateDynamicRules({
                    removeRuleIds: rules.map(rule => rule.id),
                    addRules: rules
                }, () => {
                    // Reading lastError keeps a failed update from surfacing as an unchecked error;
                    // the consequence is only that this load keeps the previous address.
                    const error = chrome.runtime.lastError;
                    if (error) log('identity rule failed: ' + (error.message || error));
                });
            } catch (error) {
                log('identity rule unavailable: ' + (error.message || error));
                return false;
            }

            current = ip;
            return true;
        }
    };
}
