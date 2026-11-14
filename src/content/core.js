// Shared runtime for the content script: state, context guard, messaging.
//
// Content scripts cannot use ES modules without a bundler, so the content layer is four classic
// scripts loaded in order by the manifest. They share one namespace object, which makes the
// coupling explicit instead of scattering it across file-scope variables.
//
// Load order: core -> detection -> engine -> index.

(function () {
    'use strict';

    if (window.__zqDetectReady) return;

    const ZQ = (window.__zq = window.__zq || {});

    // Storage and pacing constants.
    ZQ.FP_KEYS = ['fp', 'fingerprint', 'device_fp'];
    // The rotation log lives in localStorage: the site clears sessionStorage on load, which would
    // otherwise reset the counters on every reload the rotation itself triggers.
    ZQ.STATE_KEY = 'zqRotationState';
    // The server throttles bursts per client address; rotations are paced to stay civil.
    ZQ.MIN_GAP_MS = 2500;

    ZQ.state = {
        enabled: true,
        autoRefresh: true,
        rotating: false,
        retryTimer: null,
        contextAlive: true
    };

    function isInvalidated(error) {
        return String((error && error.message) || error || '').includes('Extension context invalidated');
    }

    // Reloading the extension leaves this script running in open tabs, where every chrome.* call
    // throws. There is nothing useful left to do — the page keeps working and a reload injects a
    // fresh copy — so it goes quiet instead of throwing into the page's error handler.
    ZQ.noteContextError = function (error) {
        if (!isInvalidated(error)) return;

        ZQ.state.contextAlive = false;

        // A reload already scheduled would still fire, throwing the user out of a page for no
        // benefit: the replacement script only arrives after that reload.
        if (ZQ.state.retryTimer) {
            clearTimeout(ZQ.state.retryTimer);
            ZQ.state.retryTimer = null;
            ZQ.writeState({ backoffUntil: 0 });
        }
    };

    // Sends a message and never throws: resolves null once the context is gone.
    ZQ.send = function (message) {
        if (!ZQ.state.contextAlive) return Promise.resolve(null);

        try {
            return Promise.resolve(chrome.runtime.sendMessage(message)).catch(error => {
                ZQ.noteContextError(error);
                return null;
            });
        } catch (error) {
            ZQ.noteContextError(error);
            return Promise.resolve(null);
        }
    };
})();
