const assert = require('node:assert/strict');
const { belongs, processKind } = require('../../tools/clean-processes.cjs');

const root = 'E:\\edge-extensions\\tencent-ai-detect';
const relay = `${root}\\scripts\\relay.cjs`;
const host = `${root}\\scripts\\nm-host.cjs`;
const cases = [
    ['absolute relay path', `"C:\\Program Files\\nodejs\\node.exe" "${relay}"`, 'relay'],
    ['forward-slash relay path', 'node.exe "E:/edge-extensions/tencent-ai-detect/scripts/relay.cjs"', 'relay'],
    ['absolute native-host path', `node.exe "${host}"`, 'nm-host'],
    ['test helper is not relay', `node.exe "${root}\\scripts\\test-relay.cjs"`, null],
    ['diagnostic helper is not relay', `node.exe "${root}\\scripts\\diag-relay-orphan.cjs"`, null],
    ['sibling checkout is not this checkout', 'node.exe "E:\\edge-extensions\\tencent-ai-detect-next\\scripts\\relay.cjs"', null],
    ['other checkout is not this checkout', 'node.exe "D:\\other\\tencent-ai-detect\\scripts\\relay.cjs"', null],
    ['relative path is not trusted', 'node.exe scripts/relay.cjs', null],
    ['script mentioned inside eval is not entry point', `node.exe -e "require('${relay}')"`, null],
    // The manifest launches the host through host/nm-host.bat, which passes
    // "%~dp0..\scripts\nm-host.cjs". Resolving that ".." is required, otherwise the only
    // host the browser actually starts is never recognised.
    ['native host launched through the batch file', `node  "${root}\\host\\..\\scripts\\nm-host.cjs"`, 'nm-host'],
    ['native host via the batch file, forward slashes',
        `node "${root.replace(/\\/g, '/')}/host/../scripts/nm-host.cjs"`, 'nm-host'],
    ['parent escape to a sibling is not this checkout',
        `node.exe "${root}\\..\\other\\scripts\\relay.cjs"`, null],
    ['suffix appended to the script name is not the entry point',
        `node.exe "${root}\\scripts\\xrelay.cjs"`, null]
];

let failures = 0;
for (const [name, command, expected] of cases) {
    const actual = processKind({ command }, root);
    try {
        assert.equal(actual, expected);
        assert.equal(belongs({ command }, root), expected !== null);
        process.stdout.write(`  ok    ${name}\n`);
    } catch (error) {
        failures++;
        process.stdout.write(`  FAIL  ${name}: ${error.message}\n`);
    }
}

if (failures) {
    process.stderr.write(`\n${failures} process identity check(s) failed\n`);
    process.exitCode = 1;
} else {
    process.stdout.write('\nPASS: 13/13 process identity checks\n');
}
