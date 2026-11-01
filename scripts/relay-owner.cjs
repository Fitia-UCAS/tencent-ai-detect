// Attributes a relay process to the browser that owns it.
//
// Both the extension under test and any other Edge window with the extension loaded produce
// the same process shape: relay -> nm-host -> cmd.exe (nm-host.bat) -> browser. Comparing the
// browser's --user-data-dir against the test harness's throwaway profile is what distinguishes
// them, and that distinction matters: when another browser owns the relay, disabling the switch
// under test stops nothing and the port comes back when that browser's keepalive fires, so an
// assertion about "the relay stopped" measures the other browser instead of the code.
//
// Read-only: this only walks process metadata.
const { spawnSync } = require('node:child_process');

function ps(script) {
    const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', timeout: 12000
    });
    return String(result.stdout || '').trim();
}

function processInfo(pid) {
    if (!pid) return null;

    const out = ps(
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}' -ErrorAction SilentlyContinue; ` +
        `if ($p) { "$($p.ParentProcessId)|$($p.Name)|$($p.CommandLine)" }`
    );
    if (!out) return null;

    const first = out.indexOf('|');
    const second = out.indexOf('|', first + 1);
    return {
        parent: Number(out.slice(0, first)),
        name: out.slice(first + 1, second),
        command: out.slice(second + 1)
    };
}

function profileOf(command) {
    const match = /--user-data-dir=(?:"([^"]*)"|(\S+))/.exec(command || '');
    return match ? (match[1] || match[2] || '') : null;
}

// Walks up from a relay to the browser that launched it. Returns null when the chain cannot be
// read, so callers can tell "no owner found" apart from "owned by someone else".
function browserOwning(relayPid) {
    let current = Number(relayPid);
    if (!Number.isInteger(current) || current <= 0) return null;

    for (let depth = 0; depth < 8 && current > 0; depth++) {
        const info = processInfo(current);
        if (!info) return null;

        if (/^(msedge|chrome|chromium)/i.test(info.name)) {
            return { pid: current, name: info.name, profile: profileOf(info.command) };
        }

        current = info.parent;
    }

    return null;
}

// True when the relay belongs to a browser other than the one this test started.
function ownedByOtherBrowser(relayPid, testProfile) {
    const owner = browserOwning(relayPid);
    if (!owner) return { other: false, owner: null, known: false };

    const normalized = value => String(value || '').replace(/[\\/]+$/, '').toLowerCase();
    const other = normalized(owner.profile) !== normalized(testProfile);

    return { other, owner, known: true };
}

module.exports = { browserOwning, ownedByOtherBrowser };
