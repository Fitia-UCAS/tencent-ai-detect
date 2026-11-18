// Content script manifest: the files load in this order and share one namespace.
//
// Load order matters — core defines the runtime, identity picks this load's address, detection
// reads the page, snapshot describes the parts of it worth recording, engine performs a rotation,
// auto.js provides detection.js with the detectButton lookup, and index registers the listeners.
// Keep this list, manifest.json and src/background/app.js CONTENT_FILES in step.

export const CONTENT_FILES = [
    'src/content/core.js',
    'src/content/identity.js',
    'src/content/detection.js',
    'src/content/snapshot.js',
    'src/content/engine.js',
    'src/content/auto.js',
    'src/content/index.js'
];
