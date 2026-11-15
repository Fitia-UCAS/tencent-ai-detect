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
    //
    // Both surfaces below are per tab, and they have to be. localStorage is shared by every tab of
    // the site, so the address one tab published overwrote what the next tab read - which is how two
    // tabs ended up disagreeing about the address. The header rules are per tab now, so the value
    // the socket carries has to be per tab too.
    //
    // Two surfaces because each covers the other's failure: an attribute on <html> is what the shim
    // reads synchronously, and sessionStorage still holds the value if the element is replaced.
    // localStorage is kept for the rotation log, which does have to survive a reload.
    ZQ.IDENTITY_KEY = 'zqXff';
    // Bumped by the shim on every relay socket it opens.
    ZQ.USE_COUNT_KEY = 'zqXffUses';
    ZQ.IDENTITY_ATTR = 'data-zq-xff';
    ZQ.USE_COUNT_ATTR = 'data-zq-xff-uses';

    // Never throws: a locked-down profile can refuse sessionStorage, and documentElement is absent
    // if document_start beats the parser.
    function writeAttribute(attr, value) {
        try {
            const root = document.documentElement;
            if (!root || !root.setAttribute) return false;
            root.setAttribute(attr, value);
            return true;
        } catch (e) {
            return false;
        }
    }

    function writeSession(key, value) {
        try {
            sessionStorage.setItem(key, value);
            return true;
        } catch (e) {
            return false;
        }
    }

    function readAttribute(attr) {
        try {
            const root = document.documentElement;
            return root && root.getAttribute ? root.getAttribute(attr) : null;
        } catch (e) {
            return null;
        }
    }

    function readSession(key) {
        try {
            return sessionStorage.getItem(key);
        } catch (e) {
            return null;
        }
    }

    // The shim reads the attribute when the page opens its socket, which is later than this runs, so
    // a missing <html> only has to be waited out. The retry is bounded: a page that never produces an
    // element must not keep a timer alive.
    function retryAttribute(attr, value) {
        if (writeAttribute(attr, value)) return;

        let tries = 0;
        const timer = setInterval(() => {
            tries += 1;
            if (writeAttribute(attr, value) || tries >= 40) clearInterval(timer);
        }, 25);
    }

    // The server reports 5 detections per address: the count it sends back walks 5,4,3,2,1,0 and stays
    // at 0. Stopping at 4 threw away one of them - the fifth was still paid for and never used. The
    // count is of handshakes this address has performed, so the limit is the number it may perform,
    // not one less.
    ZQ.USES_PER_IDENTITY = 5;

    // Modes for what happens once the address is spent. Reported by the panel so this stays one
    // decision rather than three code paths that each guess.
    ZQ.SPENT_MODES = ['manual', 'press', 'delay', 'immediate'];

    // Same ranges the relay draws from, so a chosen address looks like a normal client.
    ZQ.IDENTITY_PREFIXES = [
        '112.80', '112.82', '112.51', '112.55', '112.157', '112.214',
        '116.25', '120.204', '183.192', '221.226', '58.216', '61.147',
        '180.97', '182.61', '39.156', '223.5', '106.11', '121.40',
        '118.31', '121.199', '140.205', '47.96', '101.226', '175.6',
        '222.186', '110.184', '171.88', '125.64', '182.150', '119.147'
    ];

    ZQ.randomIdentity = function randomIdentity() {
        const prefix = ZQ.IDENTITY_PREFIXES[Math.floor(Math.random() * ZQ.IDENTITY_PREFIXES.length)];
        const octet = () => 1 + Math.floor(Math.random() * 254);

        return `${prefix}.${octet()}.${octet()}`;
    };

    // One identity for the whole load, so the socket and the captcha request made moments later
    // agree. Memoized rather than read back from storage: a stored value belongs to a spent address.
    let loadIdentity = null;

    ZQ.ensureIdentity = function ensureIdentity() {
        if (loadIdentity) return loadIdentity;

        loadIdentity = ZQ.randomIdentity();

        // Per tab, on both surfaces. A page that cannot record its address would let the socket
        // present whatever the relay picks, which is a different address from the ticket's.
        writeSession(ZQ.IDENTITY_KEY, loadIdentity);
        retryAttribute(ZQ.IDENTITY_ATTR, loadIdentity);

        // Also written to the shared copy, and only as a fallback for the shim.
        //
        // The shim runs in the page's own world and reads the attribute first, then sessionStorage,
        // then localStorage. Leaving this one unwritten made the last step read either nothing or a
        // value left over from an earlier load, and both are fatal: with no address on the socket the
        // relay draws a random one, and with a stale one it disagrees with the header rule - either
        // way the ticket's address and the socket's differ and the server refuses every detection.
        // Written last so the per-tab surfaces are already in place.
        try {
            localStorage.setItem(ZQ.IDENTITY_KEY, loadIdentity);
        } catch (e) {
            // Storage blocked; the two per-tab surfaces above are what the shim prefers anyway.
        }

        // A new address starts with a clean handshake count.
        writeSession(ZQ.USE_COUNT_KEY, '0');
        retryAttribute(ZQ.USE_COUNT_ATTR, '0');

        return loadIdentity;
    };

    // How many handshakes this address has performed, as counted by the shim.
    ZQ.identityUses = function identityUses() {
        const raw = readAttribute(ZQ.USE_COUNT_ATTR) || readSession(ZQ.USE_COUNT_KEY);
        const stored = Number(raw);
        return Number.isFinite(stored) && stored > 0 ? stored : 0;
    };

    // Whether this load's address can no longer serve a detection. One predicate, so every trigger
    // agrees on the limit instead of comparing the count itself.
    ZQ.identitySpent = function identitySpent() {
        return ZQ.identityUses() >= ZQ.USES_PER_IDENTITY;
    };

    // The spent state is reported once per load. The watchdog reads the count every two seconds, so
    // without this the panel would be told the same thing on every tick.
    let spentReported = false;

    ZQ.reportSpentOnce = function reportSpentOnce() {
        if (spentReported) return;
        spentReported = true;

        ZQ.reportState(ZQ.currentState('identity-spent'));
    };

    // The address this load picked, or null before one was chosen.
    ZQ.currentIdentity = function currentIdentity() {
        if (loadIdentity) return loadIdentity;

        const stored = readAttribute(ZQ.IDENTITY_ATTR) || readSession(ZQ.IDENTITY_KEY);
        return typeof stored === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(stored) ? stored : null;
    };

    // Whether the background confirmed that the header rule carries this load's address.
    //
    //   null   no answer yet (the rule may still be installing)
    //   true   the background read the rules back and they carry this address
    //   false  the rule was refused, so the ticket would be issued for the real address while the
    //          socket carries the synthetic one
    ZQ.state.identityConfirmed = null;

    ZQ.publishIdentity = function publishIdentity(identity, attempt) {
        if (!identity) return Promise.resolve(null);

        const tries = attempt || 1;

        return ZQ.send({ action: 'setIdentity', ip: identity }).then(response => {
            if (response && response.status === 'success') {
                ZQ.state.identityConfirmed = true;
                return response;
            }

            // One retry: the worker is often still starting when a page publishes this early, and a
            // lost race there would look exactly like a refused rule from here.
            if (tries < 2) {
                return new Promise(resolve => {
                    setTimeout(() => resolve(ZQ.publishIdentity(identity, tries + 1)), 300);
                });
            }

            ZQ.state.identityConfirmed = false;

            // A refused rule stops the detection - the ticket would be issued for another address -
            // so it has to be visible, or the page just looks broken. It also has to be retried:
            // a transient failure (worker restarting, rules being replaced) would otherwise leave
            // this load permanently unable to detect with no way back.
            ZQ.reportState(ZQ.currentState('identity-unconfirmed'));
            retryIdentity(identity);

            return response;
        });
    };

    // Identity retries are paced and bounded per load. The reload path also republishes, so this is
    // only what keeps a page from staying stuck when no reload happens.
    ZQ.IDENTITY_RETRY_MS = 5000;
    ZQ.IDENTITY_RETRY_LIMIT = 3;

    let identityRetries = 0;

    function retryIdentity(identity) {
        if (identityRetries >= ZQ.IDENTITY_RETRY_LIMIT) return;

        identityRetries += 1;

        setTimeout(() => {
            if (!ZQ.state.contextAlive || ZQ.state.identityConfirmed === true) return;
            ZQ.publishIdentity(identity);
        }, ZQ.IDENTITY_RETRY_MS * identityRetries);
    }
})();
