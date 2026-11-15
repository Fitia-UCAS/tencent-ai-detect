// Where things are on this machine, asked in one place.
//
// Every dev script used to answer for itself, and the answers were this machine: the browser's
// install path written out in full, and a home directory belonging to whoever wrote the file. Either
// one made the checkout work on exactly one computer. Both are discovered here instead, so a copy of
// the repository runs wherever the browser happens to be installed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const localAppData = () => process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

const tempDir = () => process.env.TEMP || process.env.TMP || os.tmpdir();

// The browser this project drives. Edge comes first because that is what the extension is tested in;
// the rest are here so a collaborator who does not have Edge is not blocked.
const browserCandidates = () => {
    if (process.platform === 'darwin') {
        return [
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium'
        ];
    }

    if (process.platform === 'win32') {
        const roots = [
            process.env['ProgramFiles(x86)'],
            process.env.ProgramFiles,
            process.env['ProgramW6432']
        ].filter(Boolean);
        const installs = [
            path.join('Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join('Google', 'Chrome', 'Application', 'chrome.exe')
        ];
        const perUser = installs.map(rel => path.join(localAppData(), rel));
        return roots.flatMap(root => installs.map(rel => path.join(root, rel))).concat(perUser);
    }

    return [
        '/usr/bin/microsoft-edge',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser'
    ];
};

// An explicit choice wins over the search: someone testing against a different build points
// CHROME_BIN (or ZQ_BROWSER) at it and nothing else changes. A path that does not exist is an error
// rather than a fallback, because silently launching a different browser hides the mistake.
const resolveBrowser = () => {
    const explicit = process.env.ZQ_BROWSER || process.env.CHROME_BIN;
    if (explicit) {
        if (!fs.existsSync(explicit)) {
            throw new Error('browser not found at ' + explicit + ' (from ZQ_BROWSER/CHROME_BIN)');
        }
        return explicit;
    }

    const candidates = browserCandidates();
    const found = candidates.find(candidate => fs.existsSync(candidate));
    if (found) return found;

    throw new Error('no Chromium browser found; set CHROME_BIN to its executable. Tried:\n  '
        + candidates.join('\n  '));
};

// Edge keeps each extension's storage under "<user data>/<profile>/Local Extension Settings/<id>".
// The profile is not always "Default": adding a second one names it "Profile 1", and a reader that
// assumes Default then finds nothing and reports an empty trail as if there were no events.
const edgeStoreDirs = extensionId => {
    const root = path.join(localAppData(), 'Microsoft', 'Edge', 'User Data');

    let profiles;
    try {
        profiles = fs.readdirSync(root, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .filter(name => name === 'Default' || /^Profile \d+$/.test(name));
    } catch (e) {
        profiles = ['Default'];
    }

    return profiles
        .sort((a, b) => (a === 'Default' ? -1 : b === 'Default' ? 1 : 0))
        .map(profile => path.join(root, profile, 'Local Extension Settings', extensionId));
};

// The directory that actually holds data, or the likeliest one when none does - a caller can then
// report the path it looked at instead of a path invented for it, and one that watches for new
// events keeps a stable location to poll.
const edgeStoreDir = extensionId => {
    const dirs = edgeStoreDirs(extensionId);
    return dirs.find(dir => fs.existsSync(dir)) || dirs[0];
};

module.exports = { browserCandidates, resolveBrowser, edgeStoreDirs, edgeStoreDir, tempDir, localAppData };
