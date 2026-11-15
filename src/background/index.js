// Service worker entry.
//
// The manifest loads this file. It exists only to instantiate the background app with the real
// browser surface; all behaviour lives in the sibling modules so it can be constructed with mocks.

import { createBackground } from './app.js';

// Every diagnostic in this app goes through the log sink, and the default sink discards. That made
// the identity rule path a black box: when apply() refused to install a rule, the only trace was
// "Invalid request" in the page, which names none of its inputs. The ring below keeps the last few
// lines where the extension page can read them, so a refusal can be told apart from a rule that was
// never asked for.
const LOG_KEY = 'zqBackgroundLog';
const LOG_LIMIT = 40;

function remember(line) {
    try {
        chrome.storage.local.get(LOG_KEY, held => {
            const kept = Array.isArray(held && held[LOG_KEY]) ? held[LOG_KEY] : [];
            const next = kept.concat(new Date().toISOString() + ' ' + line).slice(-LOG_LIMIT);
            chrome.storage.local.set({ [LOG_KEY]: next });
        });
    } catch (e) {
        // Logging must never take the background down.
    }
}

createBackground({ chrome, log: remember }).start();
