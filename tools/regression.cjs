// Runs the test suite, or one test, through the same entry point.
//
// Two things this is built around.
//
// First, the cost is not the tests. Each one takes 54-67ms, and the same test through `npm run`
// takes 410ms: npm's startup is about 356ms per invocation, more than five times the test. Running
// the scripts through node directly costs one process start instead of three, and turns 39 tests
// from about 16s into about 3s. Nothing is merged into a single process, so a failure still names
// its own file and a single test still runs on its own.
//
// Second, a run has to be able to take one test, one tier, or everything, with the same command.
// The default is the fast tiers; opening browser windows has to be asked for.
//
//   node tools/regression.cjs                 fast tiers (no browser windows)
//   node tools/regression.cjs --tier hermetic  one tier
//   node tools/regression.cjs --only relay     names containing "relay"
//   node tools/regression.cjs --one test:relay-pid   exactly one script
//   node tools/regression.cjs --list           what would run
//   node tools/regression.cjs --with-browser   include the browser tier
//
// Tier comes from what a file actually needs, not from the directory it sits in. tests/unit holds
// files that start a relay and files that only parse a string; the directory says nothing.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SELF = 'regression.cjs';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const valueOf = name => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
};

const listOnly = flag('--list');
const withBrowser = flag('--with-browser');
const only = valueOf('--only');
const one = valueOf('--one');
const tier = valueOf('--tier');

if ((flag('--only') && !only) || (flag('--one') && !one) || (flag('--tier') && !tier)) {
    process.stderr.write('--only, --one and --tier each need a value\n');
    process.exit(2);
}

// A child must never re-enter this file: registering the runner as a test:* script makes that a
// real possibility, and the recursion it produced once was dozens of nested npm processes.
if (process.env.ZQ_REGRESSION_CHILD === '1') {
    process.stderr.write('refusing to run: tools/regression.cjs was invoked from itself\n');
    process.exit(2);
}

// --- classification ---------------------------------------------------------

// Classification reads the file the script runs, not the script's name.
//
// The browser marker is `launch(` or `cdp(` imported from the harness, not the mere presence of
// the harness: tests/integration/test-relay-identity.cjs imports it only for `sleep` and runs no
// browser, so treating the import as the signal would misfile it. The regexes below are applied to
// the whole file with no line-distance assumption, because a destructured import and the first
// call can be dozens of lines apart.
const NEEDS_BROWSER = /\bloadExtension\b|--user-data-dir|remote-debugging-port|\b(?:await\s+)?launch\s*\(\s*\{|\bcdp\s*\(\s*(?:ws|url|session)/;
const IMPORTS_HARNESS = /require\([^)]*browser-harness\.cjs/;
const NEEDS_REAL_SERVICE = /HOST\s*=\s*['"]matrix\.tencent\.com['"]/;
const CONNECTS = /\btls\.connect\s*\(|\bnet\.connect\s*\(|\bhttps?\.(?:get|request)\s*\(\s*\{/;
const SPAWNS = /\bspawn(?:Sync)?\s*\(/;

function readFileSafely(file) {
    try {
        return fs.readFileSync(path.join(ROOT, file), 'utf8');
    } catch {
        return '';
    }
}

function tierOf(scriptCommand) {
    const file = String(scriptCommand).replace(/^node\s+/, '').trim();
    const source = readFileSafely(file);

    // A file under tests/e2e with a harness import and a launch call is a browser test whatever
    // else it contains. Checking the explicit markers first keeps this independent of directory.
    if (NEEDS_BROWSER.test(source)) return 'browser';
    if (IMPORTS_HARNESS.test(source) && /\blaunch\b/.test(source)) return 'browser';

    if (NEEDS_REAL_SERVICE.test(source) && CONNECTS.test(source)) return 'service';
    if (CONNECTS.test(source)) return 'local-network';
    if (SPAWNS.test(source)) return 'process';
    return 'hermetic';
}

const TIER_ORDER = ['hermetic', 'process', 'local-network', 'service', 'browser'];
// Anything at service or above needs the real site or a real browser; the default run stops before
// browser because each test there opens its own window.
const DEFAULT_TIERS = new Set(['hermetic', 'process', 'local-network', 'service']);

// --- selection --------------------------------------------------------------

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

let selected = Object.keys(pkg.scripts)
    .filter(name => name.startsWith('test:'))
    .filter(name => !String(pkg.scripts[name]).includes(SELF))
    .map(name => ({
        name,
        command: String(pkg.scripts[name]),
        tier: tierOf(pkg.scripts[name])
    }));

if (one) {
    selected = selected.filter(entry => entry.name === one);
    if (!selected.length) {
        process.stderr.write(`no test script named "${one}"\n`);
        process.exit(2);
    }
}

if (only) selected = selected.filter(entry => entry.name.includes(only));

if (tier) {
    if (!TIER_ORDER.includes(tier)) {
        process.stderr.write(`unknown tier "${tier}"; expected one of ${TIER_ORDER.join(', ')}\n`);
        process.exit(2);
    }
    selected = selected.filter(entry => entry.tier === tier);
}

if (!one && !tier && !only && !withBrowser) {
    selected = selected.filter(entry => DEFAULT_TIERS.has(entry.tier));
}

if (!withBrowser) selected = selected.filter(entry => entry.tier !== 'browser');

// Sorted by tier so the cheap answers arrive first when something is wrong.
selected.sort((a, b) =>
    TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || a.name.localeCompare(b.name));

if (!selected.length) {
    process.stderr.write('no test script matched\n');
    process.exit(2);
}

if (listOnly) {
    let currentTier = null;
    for (const entry of selected) {
        if (entry.tier !== currentTier) {
            currentTier = entry.tier;
            process.stdout.write(`\n${currentTier}\n`);
        }
        process.stdout.write('  ' + entry.name + '\n');
    }
    process.stdout.write(`\n${selected.length} script(s)\n`);
    process.exit(0);
}

// --- run --------------------------------------------------------------------

// A script whose command is a plain `node <file>` does not need npm, a shell, or either one's
// startup cost. Anything else (a chained command, an env assignment) keeps the shell path.
function executionFor(command) {
    const plain = /^node\s+([^&|;$<>]+?)\s*$/.exec(command);
    if (plain) {
        return { via: 'node', file: plain[1] };
    }
    return { via: 'shell', command };
}

const results = [];
const started = Date.now();

for (const entry of selected) {
    const began = Date.now();
    const how = executionFor(entry.command);

    const run = how.via === 'node'
        ? spawnSync(process.execPath, [how.file], {
            cwd: ROOT,
            encoding: 'utf8',
            timeout: 300000,
            env: Object.assign({}, process.env, { ZQ_REGRESSION_CHILD: '1' })
        })
        : spawnSync(how.command, {
            cwd: ROOT,
            encoding: 'utf8',
            timeout: 300000,
            shell: true,
            env: Object.assign({}, process.env, { ZQ_REGRESSION_CHILD: '1' })
        });

    const seconds = (Date.now() - began) / 1000;
    const output = (run.stdout || '') + (run.stderr || '');
    const passed = run.status === 0;

    results.push({ ...entry, passed, seconds, output });
    process.stdout.write(`${passed ? 'pass' : 'FAIL'}  ${entry.name.padEnd(34)} ${seconds.toFixed(1)}s\n`);

    if (!passed) {
        const lines = output.split('\n').filter(Boolean);
        const signal = lines.filter(line => /FAIL|AssertionError|Error:|timed out|not ok/.test(line));
        for (const line of (signal.length ? signal : lines).slice(-6)) {
            process.stdout.write('        ' + line.trim().slice(0, 160) + '\n');
        }
    }
}

const failed = results.filter(result => !result.passed);
const total = ((Date.now() - started) / 1000).toFixed(1);

process.stdout.write('\n' + '─'.repeat(62) + '\n');
process.stdout.write(`${results.length - failed.length}/${results.length} passed in ${total}s\n`);

if (failed.length) {
    process.stdout.write('\nfailed:\n');
    for (const result of failed) process.stdout.write(`  ${result.name}  (${result.tier})\n`);
    process.exitCode = 1;
}

const skippedBrowser = Object.keys(pkg.scripts)
    .filter(name => name.startsWith('test:'))
    .map(name => ({ name, tier: tierOf(pkg.scripts[name]) }))
    .filter(entry => entry.tier === 'browser' && !selected.some(s => s.name === entry.name));

if (skippedBrowser.length && !one && !tier && !only) {
    process.stdout.write(
        `\n${skippedBrowser.length} browser test(s) not run: each opens its own window.\n`
        + 'Run them one at a time, or add --with-browser.\n'
    );
}

const reportPath = path.join(path.dirname(ROOT), 'tencent-ai-detect-regression.txt');
const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();

fs.writeFileSync(reportPath, [
    'tencent-ai-detect regression',
    'commit ' + commit,
    'date   ' + new Date().toISOString(),
    '',
    ...results.map(r => `${r.passed ? 'PASS' : 'FAIL'}  ${r.tier.padEnd(14)} ${r.name.padEnd(34)} ${r.seconds.toFixed(1)}s`),
    '',
    `${results.length - failed.length}/${results.length} passed in ${total}s`
].join('\n') + '\n');

process.stdout.write(`report: ${reportPath}\n`);
