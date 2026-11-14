// Content script manifest: the five files load in this order and share one namespace.
//
// Load order matters — core defines the runtime, identity picks this load's address, detection
// reads the page, engine performs a rotation, and index registers the listeners. Keep this list,
// manifest.json and src/background/app.js CONTENT_FILES in step.

export const CONTENT_FILES = [
    'src/content/core.js',
    'src/content/identity.js',
    'src/content/detection.js',
    'src/content/engine.js',
    'src/content/index.js'
];
