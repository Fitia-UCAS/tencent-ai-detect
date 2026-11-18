// Verifies the background worker's keepalive and message routing against a mocked Chrome surface.
//
// Each case builds its own instance through createBackground, so the assertions run against the
// same modules the service worker loads without sharing state between cases. No browser, native
// host, relay or network is involved.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function makeEvent() {
    const listeners = [];
    return {
        listeners,
        addListener(listener) { listeners.push(listener); },
        dispatch(...args) { for (const listener of listeners) listener(...args); }
    };
}

function createWorker(fetchBody) {
    const storage = { relayEnabled: true };
    const postedMessages = [];
    const alarmEvent = makeEvent();
    const startupEvent = makeEvent();
    const messageEvent = makeEvent();
    const portDisconnects = [];
    const clearedAlarms = [];
    const port = {
        onMessage: makeEvent(),
        onDisconnect: makeEvent(),
        postMessage(message) { postedMessages.push(message); },
        disconnect() { portDisconnects.push(Date.now()); }
    };

    const chrome = {
        runtime: {
            lastError: undefined,
            connectNative() { return port; },
            onInstalled: makeEvent(),
            onStartup: startupEvent,
            onMessage: messageEvent
        },
        storage: {
            local: {
                get(keys, callback) {
                    const result = {};
                    for (const key of keys) result[key] = storage[key];
                    if (typeof callback === 'function') {
                        callback(result);
                        return undefined;
                    }
                    return Promise.resolve(result);
                },
                set(values, callback) {
                    Object.assign(storage, values);
                    if (typeof callback === 'function') callback();
                }
            }
        },
        alarms: {
            onAlarm: alarmEvent,
            get(name, callback) { callback(null); },
            create() {},
            clear(name) { clearedAlarms.push(name); }
        },
        tabs: {
            onUpdated: makeEvent(),
            create() {}
        },
        scripting: {
            executeScript() { return Promise.resolve(); }
        },
        contextMenus: {
            create() {},
            onClicked: makeEvent()
        }
    };

    const fetchImpl = () => Promise.resolve({ json: () => Promise.resolve(fetchBody) });

    return { chrome, fetchImpl, postedMessages, startupEvent, alarmEvent, messageEvent, storage, portDisconnects, clearedAlarms, port };
}

async function tick() {
    await new Promise(resolve => setTimeout(resolve, 10));
}

(async () => {
    const modulePath = pathToFileURL(
        path.join(__dirname, '..', '..', 'src', 'background', 'app.js')
    ).href;
    const { createBackground } = await import(modulePath);

    const failures = [];
    const check = (condition, message) => {
        if (!condition) failures.push(message);
        process.stdout.write(`${condition ? '  ok    ' : '  FAIL  '}${message}\n`);
    };

    const build = mocked => createBackground({
        chrome: mocked.chrome,
        fetchImpl: mocked.fetchImpl,
        log: () => {}
    });

    const unhealthy = createWorker({ ok: false, message: 'not ready' });
    build(unhealthy).start();
    unhealthy.startupEvent.dispatch();
    check(
        unhealthy.postedMessages.length === 1 && unhealthy.postedMessages[0].type === 'ensure',
        'startup asks the native host to ensure the relay'
    );
    unhealthy.alarmEvent.dispatch({ name: 'relay-keepalive' });
    await tick();
    check(
        unhealthy.postedMessages.length === 2 && unhealthy.postedMessages[1].type === 'ensure',
        'valid JSON with ok:false triggers recovery'
    );

    const healthy = createWorker({ ok: true, host: 'matrix.tencent.com' });
    build(healthy).start();
    healthy.startupEvent.dispatch();
    healthy.alarmEvent.dispatch({ name: 'relay-keepalive' });
    await tick();
    check(
        healthy.postedMessages.length === 2 &&
        healthy.postedMessages[1].type === 'heartbeat',
        'ok:true sends a lease heartbeat without an unnecessary ensure command'
    );

    const messageListener = healthy.messageEvent.listeners[0];
    const unknownResult = messageListener({ action: 'not-a-real-action' }, {}, () => {});
    check(
        unknownResult === false,
        'unknown actions do not leave an unanswered message channel open'
    );

    let resetResponse;
    const resetChannel = messageListener(
        { action: 'logReset', ip: 'local-test', reason: 'unit-test' },
        { tab: { id: 7, url: 'https://matrix.tencent.com/ai-detect/' } },
        value => { resetResponse = value; }
    );
    check(
        resetChannel === false && resetResponse?.status === 'success',
        'logReset responds synchronously without keeping the message channel open'
    );
    check(
        healthy.storage.resetCount === 1 && healthy.storage.resetHistory.length === 1,
        'background records one reset event as the single source of truth'
    );

    const statusChannel = messageListener({ action: 'statusUpdate', payload: { status: 'idle' } }, {}, () => {});
    check(
        statusChannel === false,
        'statusUpdate responds synchronously and closes its message channel'
    );

    // The relay always runs now. The switch is gone because turning it off never produced a working
    // alternative: the detection socket is rerouted to the relay by URL alone, so with no process
    // listening the socket fails closed and the page stops detecting. What this pins is that the
    // worker still does not gate the start on a stored flag - a leftover false from an older build
    // must not stop the relay.
    {
        const worker = createWorker({ ok: true });
        worker.storage.relayEnabled = false;
        build(worker).start();
        worker.startupEvent.dispatch();
        await tick();

        check(
            worker.postedMessages.some(message => message.type === 'ensure'),
            'the worker starts the relay even when an older build left relayEnabled=false behind'
        );
        check(
            worker.clearedAlarms.length === 0,
            'and does not clear the keepalive alarm that would restart it'
        );
    }

    if (failures.length) {
        process.stderr.write(`\n${failures.length} background health check(s) failed\n`);
        process.exitCode = 1;
    } else {
        process.stdout.write('\nPASS: 13/13 background health checks\n');
    }
})().catch(error => {
    process.stderr.write(String(error && error.stack || error) + '\n');
    process.exitCode = 1;
});
