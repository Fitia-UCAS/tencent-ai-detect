// Verifies a wedged native host is replaced instead of being asked forever.
//
// A host whose spawn path broke accepts `ensure` and does nothing, while the port still reports as
// connected. The worker used to re-send `ensure` on every tick, so the relay stayed down until the
// browser was restarted. These cases pin the counter that breaks that loop.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = pathToFileURL(
    path.resolve(__dirname, '..', '..', 'src', 'background', 'keepalive.js')
).href;

// A host whose port stays up once connected - the wedged case. `command` mirrors the module: when
// the port is gone it connects a new one, so the next tick finds it up again.
function makeHost({ connected = true } = {}) {
    const calls = [];
    let isConnected = connected;

    return {
        calls,
        isConnected: () => isConnected,
        disconnect() {
            calls.push('disconnect');
            isConnected = false;
        },
        command(type) {
            calls.push(type);
            isConnected = true;
        }
    };
}

function makeChrome() {
    return {
        storage: { local: { get: async () => ({ relayEnabled: true }) } },
        alarms: { get() {}, create() {}, clear() {} }
    };
}

(async () => {
    const { createKeepAlive } = await import(MODULE);

    const failures = [];
    const check = (name, fn) => {
        try {
            fn();
            process.stdout.write(`  ok    ${name}\n`);
        } catch (error) {
            failures.push(name);
            process.stdout.write(`  FAIL  ${name} - ${error.message}\n`);
        }
    };

    const build = (host, healthy) => createKeepAlive({
        chrome: makeChrome(),
        health: { ping: async () => (healthy ? { ok: true } : { ok: false }) },
        host,
        alarmName: 'relay-keepalive',
        keys: { relayEnabled: 'relayEnabled' }
    });

    // --- a healthy relay is only told to renew its lease -------------------
    {
        const host = makeHost();
        await build(host, true).keepAlive();
        check('a healthy tick sends heartbeat only', () => {
            assert.deepEqual(host.calls, ['heartbeat']);
        });
    }

    // --- one failed tick reuses the existing host --------------------------
    {
        const host = makeHost();
        await build(host, false).keepAlive();
        check('the first failure asks the existing host', () => {
            assert.deepEqual(host.calls, ['ensure'], 'must not reconnect on the first miss');
        });
    }

    // --- two consecutive failures replace the host -------------------------
    {
        const host = makeHost();
        const keepAlive = build(host, false);

        await keepAlive.keepAlive();
        await keepAlive.keepAlive();

        check('two failures drop the port and ask again', () => {
            assert.ok(host.calls.includes('disconnect'), 'the wedged port must be dropped');
            assert.equal(host.calls[host.calls.length - 1], 'ensure', 'and a new host must be asked');
        });
    }

    // --- a healthy tick in between resets the count -----------------------
    {
        const host = makeHost();
        let healthy = false;
        const keepAlive = createKeepAlive({
            chrome: makeChrome(),
            health: { ping: async () => ({ ok: healthy }) },
            host,
            alarmName: 'relay-keepalive',
            keys: { relayEnabled: 'relayEnabled' }
        });

        await keepAlive.keepAlive();   // failure 1
        healthy = true;
        await keepAlive.keepAlive();   // healthy, resets
        healthy = false;
        await keepAlive.keepAlive();   // failure 1 again

        check('a healthy tick resets the failure count', () => {
            assert.ok(!host.calls.includes('disconnect'),
                'a slow respawn must not be treated as a wedged host');
        });
    }

    // --- a host that cannot connect at all: never try to disconnect --------
    // This is the broken-registration case: connectNative keeps failing, so no port ever exists and
    // there is nothing to drop. Disconnecting would be a no-op that hides the real problem.
    {
        const calls = [];
        const host = {
            isConnected: () => false,
            disconnect() { calls.push('disconnect'); },
            command(type) { calls.push(type); }
        };

        const keepAlive = build(host, false);

        await keepAlive.keepAlive();
        await keepAlive.keepAlive();

        check('a host that never connects is only asked, never disconnected', () => {
            assert.ok(!calls.includes('disconnect'), 'there is no port to drop');
            assert.ok(calls.every(call => call === 'ensure'));
        });
    }

    if (failures.length) {
        process.stdout.write(`\nFAIL: ${failures.length} of 5 checks\n`);
        process.exitCode = 1;
    } else {
        process.stdout.write('\nPASS: 5/5 keepalive recovery checks\n');
    }
})().catch(error => {
    process.stderr.write(`load failed: ${error.message}\n`);
    process.exitCode = 1;
});
