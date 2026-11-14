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
    const resetUsageChannel = messageListener({ action: 'resetUsage' }, {}, () => {});
    check(
        statusChannel === false && resetUsageChannel === false,
        'all other synchronous background actions close their message channels'
    );

    // The side-panel switch must actually stop the relay's owner, not just persist a flag.
    // Turning it off has to drop the native port (the host exits on stdin EOF and takes the relay
    // with it) and clear the keepalive alarm, otherwise the next tick restarts what was just stopped.
    {
        const worker = createWorker({ ok: true });
        build(worker).start();
        worker.startupEvent.dispatch();
        await tick();

        const listener = worker.messageEvent.listeners[0];
        const before = worker.portDisconnects.length;

        let response;
        const channel = listener({ action: 'setRelay', enabled: false }, {}, value => { response = value; });
        await tick();

        check(worker.storage.relayEnabled === false, 'switching the relay off persists the disabled state');
        check(
            worker.portDisconnects.length === before + 1,
            'switching the relay off drops the native port so the host tears the relay down'
        );
        check(
            worker.clearedAlarms.includes('relay-keepalive'),
            'switching the relay off clears the keepalive alarm so it cannot restart the relay'
        );
        check(
            channel === true && response?.status === 'success',
            'the async stop path keeps its channel open and then answers'
        );

        const postedBefore = worker.postedMessages.length;
        worker.storage.relayEnabled = true;
        let onResponse;
        listener({ action: 'setRelay', enabled: true }, {}, value => { onResponse = value; });
        await tick();

        check(
            worker.postedMessages.length > postedBefore &&
            worker.postedMessages[worker.postedMessages.length - 1].type === 'ensure',
            'switching the relay on asks the host to ensure the relay is running'
        );
        check(onResponse?.status === 'success', 'the enable path answers after the health probe');
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
