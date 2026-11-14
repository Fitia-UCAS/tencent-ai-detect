// Service worker entry.
//
// The manifest loads this file. It exists only to instantiate the background app with the real
// browser surface; all behaviour lives in the sibling modules so it can be constructed with mocks.

import { createBackground } from './app.js';

createBackground({ chrome }).start();
