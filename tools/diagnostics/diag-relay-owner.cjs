// Traces a running relay back to the browser that owns it.
//
// Both the extension under test and any other Edge window with the extension loaded produce
// the same shape of process tree (relay -> nm-host -> cmd.exe -> browser), so the chain alone
// does not say whose it is. What distinguishes them is the browser's --user-data-dir: the test
// harness always uses a throwaway temp profile, while a normal window uses the default one.
//
// This prints the full chain with the resolved profile, so a leftover relay can be attributed
// instead of guessed at.
const { spawnSync } = require('node:child_process');

function ps(script) {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', timeout: 12000
    });
    return String(r.stdout || '').trim();
}

function proc(pid) {
    const out = ps(
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}' -ErrorAction SilentlyContinue; ` +
        `if ($p) { "$($p.ProcessId)|$($p.ParentProcessId)|$($p.Name)|$($p.CommandLine)" }`
    );
    if (!out) return null;
    const [id, parent, name, ...rest] = out.split('|');
    return { pid: Number(id), parent: Number(parent), name, command: rest.join('|') };
}

function profileOf(command) {
    const match = /--user-data-dir=("([^"]*)"|(\S+))/.exec(command || '');
    if (!match) return '(none)';

    const value = match[2] || match[3] || '';
    const temp = process.env.TEMP || 'C:\\Users\\aFei\\AppData\\Local\\Temp';
    return value.toLowerCase().startsWith(temp.toLowerCase())
        ? `${value}  ← test harness temp profile`
        : `${value}  ← default / real profile`;
}

// Every relay this checkout could have started.
const relays = ps(
    `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ` +
    `ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`
).split(/\r?\n/).filter(Boolean)
    .map(line => {
        const i = line.indexOf('|');
        return { pid: Number(line.slice(0, i)), command: line.slice(i + 1) };
    })
    .filter(p => p.pid > 0 && /relay\.cjs/.test(p.command));

if (!relays.length) {
    console.log('no relay.cjs process is running');
    process.exit(0);
}

for (const relay of relays) {
    console.log(`\nrelay pid=${relay.pid}`);

    let current = relay.pid;
    for (let depth = 0; depth < 6 && current > 0; depth++) {
        const info = proc(current);
        if (!info) break;

        const label = info.name.toLowerCase().endsWith('.exe') && info.name.toLowerCase().startsWith('msedge')
            ? `   profile: ${profileOf(info.command)}`
            : '';

        console.log(`  ${'  '.repeat(depth)}${info.name} pid=${info.pid}${label}`);
        current = info.parent;
    }
}
