// The identity this page load carries.
//
// The captcha ticket is issued for the address that fetched it, so a socket on a different address
// gets the detection refused with "Invalid request". The page fetches its ticket over plain HTTPS,
// which the relay cannot touch, so all three paths have to be told the same address: this module
// picks it and publishes it, the background puts it on the page's own request headers, and the shim
// (src/shim/index.js) hands it to the socket through localStorage.
//
// Measured against the real server: an address serves four handshakes and is refused from the fifth
// onwards, permanently, and the limit is per address rather than per prefix - an untouched
// neighbour in the same /24 still works. Restoring a stored address across loads would therefore
// burn it and leave the extension unable to detect anything at all, so each load mints a new one.

(function () {
    'use strict';

    if (window.__zqDetectReady) return;

    const ZQ = (window.__zq = window.__zq || {});

    // Read back by the shim, which runs in the page's own world.
    ZQ.IDENTITY_KEY = 'zqXff';
    // Bumped by the shim on every relay socket it opens.
    ZQ.USE_COUNT_KEY = 'zqXffUses';

    // The reload has to happen before the fifth handshake is attempted.
    ZQ.USES_PER_IDENTITY = 4;

    // Same ranges the relay draws from, so a chosen address looks like a normal client.
    ZQ.IDENTITY_PREFIXES = [
        '112.80', '112.82', '112.51', '112.55', '112.157', '112.214',
        '116.25', '120.204', '183.192', '221.226', '58.216', '61.147',
        '180.97', '182.61', '39.156', '223.5', '106.11', '121.40',
        '118.31', '121.199', '140.205', '47.96', '101.226', '175.6',
        '222.186', '110.184', '171.88', '125.64', '182.150', '119.147'
    ];

    ZQ.randomIdentity = function () {
        const prefix = ZQ.IDENTITY_PREFIXES[Math.floor(Math.random() * ZQ.IDENTITY_PREFIXES.length)];
        const octet = () => 1 + Math.floor(Math.random() * 254);

        return `${prefix}.${octet()}.${octet()}`;
    };

    // One identity for the whole load, so the socket and the captcha request made moments later
    // agree. Memoized rather than read back from storage: a stored value belongs to a spent address.
    let loadIdentity = null;

    ZQ.ensureIdentity = function () {
        if (loadIdentity) return loadIdentity;

        loadIdentity = ZQ.randomIdentity();

        try {
            localStorage.setItem(ZQ.IDENTITY_KEY, loadIdentity);
            // A new address starts with a clean handshake count.
            localStorage.setItem(ZQ.USE_COUNT_KEY, '0');
        } catch {
            // Storage can be unavailable on a locked-down profile; the socket then falls back to
            // whatever the relay picks.
        }

        return loadIdentity;
    };

    // How many handshakes this address has performed, as counted by the shim.
    ZQ.identityUses = function () {
        try {
            const stored = Number(localStorage.getItem(ZQ.USE_COUNT_KEY));
            return Number.isFinite(stored) && stored > 0 ? stored : 0;
        } catch {
            // Unreadable: report none, so the page is left alone rather than reloaded blindly.
            return 0;
        }
    };

    // The address this load picked, or null before one was chosen.
    ZQ.currentIdentity = function () {
        if (loadIdentity) return loadIdentity;

        try {
            const stored = localStorage.getItem(ZQ.IDENTITY_KEY);
            return typeof stored === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(stored) ? stored : null;
        } catch {
            return null;
        }
    };

    ZQ.publishIdentity = function (identity) {
        if (!identity) return;
        ZQ.send({ action: 'setIdentity', ip: identity });
    };
})();
