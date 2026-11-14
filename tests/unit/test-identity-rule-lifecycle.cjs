// The header rule is installed asynchronously, and "the update was accepted" is not "the rules are
// live". These checks drive the real module with a fake declarativeNetRequest so each failure mode
// is reproducible without a browser.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = pathToFileURL(path.join(__dirname, '../../src/background/identity.js')).href;

// A fake that keeps the dynamic rule list and can be told to fail, lag, or report rules that differ
// from the ones it was given.
function fakeChrome({ failUpdate = false, failRead = false, dropRule = false, mutateValue = null, lag = 0, hangUpdate = false, hangRead = false } = {}) {
    // hangUpdate / hangRead model a browser call that simply never answers - the case where an
    // await would stay pending forever and take the queue with it. They are mutable so a check can
    // hang one call and then let the next one through.
    const state = { rules: [], updates: 0, reads: 0, order: [], hangUpdate, hangRead };

    const settle = (fn, value) => {
        if (lag > 0) return new Promise(resolve => setTimeout(() => resolve(fn(value)), lag));
        return Promise.resolve().then(() => fn(value));
    };

    return {
        state,
        chrome: {
            runtime: {
                lastError: null,
                setLastError(message) {
                    this.lastError = message ? { message } : null;
                }
            },
            declarativeNetRequest: {
                updateDynamicRules(changes, callback) {
                    state.updates += 1;
                    state.order.push('update:' + changes.addRules[0].action.requestHeaders[0].value);

                    // Never calls back: the caller must time out rather than wait forever.
                    if (state.hangUpdate) return;

                    if (failUpdate) {
                        this._chrome.runtime.setLastError('rule update refused');
                        callback();
                        this._chrome.runtime.setLastError(null);
                        return;
                    }

                    const next = state.rules.filter(rule => !changes.removeRuleIds.includes(rule.id));
                    for (const rule of changes.addRules) {
                        if (dropRule && rule.id === changes.addRules[changes.addRules.length - 1].id) continue;
                        const copy = JSON.parse(JSON.stringify(rule));
                        if (mutateValue) copy.action.requestHeaders[0].value = mutateValue;
                        next.push(copy);
                    }
                    state.rules = next;
                    settle(callback, undefined);
                },
                getDynamicRules(callback) {
                    state.reads += 1;
                    state.order.push('read');

                    if (state.hangRead) return;
                    if (failRead) {
                        this._chrome.runtime.setLastError('rule read refused');
                        callback([]);
                        this._chrome.runtime.setLastError(null);
                        return;
                    }
                    settle(callback, JSON.parse(JSON.stringify(state.rules)));
                }
            }
        },
        bind(chrome) {
            this.chrome.declarativeNetRequest._chrome = { runtime: chrome.runtime };
            chrome.declarativeNetRequest._chrome = { runtime: chrome.runtime };
        }
    };
}

function build(options) {
    const fake = fakeChrome(options);
    fake.bind(fake.chrome);
    return { fake, module: null };
}

const checks = [];
function check(name, run) {
    checks.push([name, run]);
}

async function load(options) {
    const fake = fakeChrome(options);
    fake.bind(fake.chrome);
    const mod = await import(MODULE);
    // The production timeout is 5s; a check that waits that long is not a useful check.
    const opTimeoutMs = options && options.opTimeoutMs ? options.opTimeoutMs : 40;
    return { fake, mod, identity: mod.createIdentityRules({ chrome: fake.chrome, opTimeoutMs }) };
}

// --- the defect this replaces -------------------------------------------------

check('apply only reports success after the rules read back', async () => {
    const { fake, identity } = await load();
    const applied = await identity.apply('112.80.1.2');

    assert.equal(applied, true, 'a verified update must report success');
    assert.equal(identity.current, '112.80.1.2');
    assert.ok(fake.state.reads >= 1, 'the rules must be read back before answering');
});

check('a refused update never reports success', async () => {
    const { identity } = await load({ failUpdate: true });
    const applied = await identity.apply('112.80.1.2');

    assert.equal(applied, false, 'a failed update must not look successful');
    assert.equal(identity.current, null, 'current must not describe an install that did not happen');
});

check('an update that lands different rules is not success', async () => {
    const { identity } = await load({ mutateValue: '9.9.9.9' });
    const applied = await identity.apply('112.80.1.2');

    assert.equal(applied, false, 'the rules carry another address, so this install failed');
    assert.equal(identity.current, null);
});

check('a partial rule set is not success', async () => {
    const { identity } = await load({ dropRule: true });
    const applied = await identity.apply('112.80.1.2');

    assert.equal(applied, false, 'one domain left on the old address means the set is not coherent');
    assert.equal(identity.current, null);
});

check('an unreadable rule set is not success', async () => {
    const { identity } = await load({ failRead: true });

    assert.equal(await identity.apply('112.80.1.2'), false, 'unverified is not verified');
});

// --- the ordering guarantees --------------------------------------------------

check('a second apply waits for the first to finish', async () => {
    const { fake, identity } = await load({ lag: 5 });

    await Promise.all([
        identity.apply('112.80.1.2'),
        identity.apply('112.80.1.3')
    ]);

    assert.deepEqual(fake.state.order.filter(step => step.startsWith('update:')),
        ['update:112.80.1.2', 'update:112.80.1.3'],
        'updates must run in the order they were requested, not interleaved');
    assert.equal(identity.current, '112.80.1.3', 'the last requested address must be the live one');
});

check('the earlier of two racing updates cannot win', async () => {
    const { identity } = await load({ lag: 8 });

    const first = identity.apply('112.80.1.2');
    const second = identity.apply('112.80.1.3');
    await Promise.all([first, second]);

    // Without serialisation the slower first update could resolve last and leave 112.80.1.2 live.
    assert.equal(identity.current, '112.80.1.3');
});

check('a repeated address is answered without touching the rules', async () => {
    const { fake, identity } = await load();

    await identity.apply('112.80.1.2');
    const updatesAfterFirst = fake.state.updates;
    assert.equal(await identity.apply('112.80.1.2'), true, 'the same address is already live');
    assert.equal(fake.state.updates, updatesAfterFirst, 'no second update should be sent');
});

check('a rejected address never reaches the rules', async () => {
    const { fake, identity } = await load();

    assert.equal(await identity.apply('1.2.3.4\r\nX-Injected: 1'), false, 'CRLF must be refused');
    assert.equal(await identity.apply(''), false);
    assert.equal(await identity.apply(null), false);
    assert.equal(fake.state.updates, 0, 'nothing may be installed for an invalid address');
});

// --- service worker restart ---------------------------------------------------

check('sync adopts the rules a previous worker installed', async () => {
    const { fake, identity } = await load();

    // Another worker installed these before this one started.
    fake.state.rules = (await import(MODULE)).buildIdentityRules('112.80.1.2');

    assert.equal(identity.current, null, 'fresh module state starts out empty');
    assert.equal(await identity.sync(), '112.80.1.2', 'sync must adopt what the browser holds');
    assert.equal(identity.current, '112.80.1.2');
});

check('after sync, the same address is not reinstalled', async () => {
    const { fake, identity, mod } = await load();
    fake.state.rules = mod.buildIdentityRules('112.80.1.2');
    await identity.sync();

    const before = fake.state.updates;
    assert.equal(await identity.apply('112.80.1.2'), true);
    assert.equal(fake.state.updates, before, 'a restart must not force a redundant update');
});

check('after sync, a different address still gets installed', async () => {
    const { fake, identity, mod } = await load();
    fake.state.rules = mod.buildIdentityRules('112.80.1.2');
    await identity.sync();

    assert.equal(await identity.apply('112.80.1.3'), true);
    assert.equal(identity.current, '112.80.1.3');
});

check('sync with no rules leaves the module empty rather than guessing', async () => {
    const { identity } = await load();
    assert.equal(await identity.sync(), null);
    assert.equal(identity.current, null);
});

// --- reading rules back -------------------------------------------------------

check('a coherent rule set reports its address', async () => {
    const mod = await import(MODULE);
    assert.equal(mod.addressFromRules(mod.buildIdentityRules('112.80.1.2')), '112.80.1.2');
});

check('a mixed rule set reports nothing', async () => {
    const mod = await import(MODULE);
    const rules = mod.buildIdentityRules('112.80.1.2');
    rules[1].action.requestHeaders[0].value = '9.9.9.9';

    assert.equal(mod.addressFromRules(rules), null, 'two addresses cannot both be the identity');
});

check('an unrelated rule is ignored', async () => {
    const mod = await import(MODULE);
    const rules = mod.buildIdentityRules('112.80.1.2');
    rules.push({ id: 99, priority: 1, action: { type: 'block' }, condition: {} });

    assert.equal(mod.addressFromRules(rules), '112.80.1.2', 'other rules must not break the check');
});

// --- serialization and liveness ----------------------------------------------

check('sync waits behind a pending apply instead of racing it', async () => {
    // A worker restart runs sync(); a page publishing at the same moment runs apply(). If sync's
    // read completes after the apply confirmed the new address, it puts the old one back into
    // `current` and the next publish skips an update that was actually needed.
    const { fake, identity } = await load({ lag: 5 });

    const applying = identity.apply('112.80.1.2');
    const syncing = identity.sync();
    await Promise.all([applying, syncing]);

    // The ordering is the assertion: unserialized, sync's read runs first, sees the pre-update
    // rules, and resolves after the apply has already confirmed the new address.
    assert.deepEqual(fake.state.order, ['update:112.80.1.2', 'read', 'read'],
        'the sync read must wait for the update it would otherwise race');
    assert.equal(identity.current, '112.80.1.2',
        'the address the apply confirmed must survive a sync that started earlier');
});

check('an apply that never answers fails closed instead of stalling the queue', async () => {
    const { fake, identity } = await load({ hangUpdate: true });

    const hung = await identity.apply('112.80.1.2');
    assert.equal(hung, false, 'an unanswered update is unverified, so it is a failure');
    assert.equal(identity.current, null, 'and it must not be recorded as installed');

    // The queue has to still be usable afterwards, or one stuck call disables every later publish.
    fake.state.hangUpdate = false;
    assert.equal(await identity.apply('112.80.1.3'), true, 'a later update must still go through');
    assert.equal(identity.current, '112.80.1.3');
});

check('a rule read that never answers does not swallow the next update', async () => {
    const { fake, identity } = await load({ hangRead: true });

    assert.equal(await identity.sync(), null, 'an unreadable rule set leaves the module empty');
    assert.equal(identity.current, null);

    fake.state.hangRead = false;
    assert.equal(await identity.apply('112.80.1.2'), true);
});

(async () => {
    let failures = 0;

    for (const [name, run] of checks) {
        try {
            await run();
            console.log('  ok    ' + name);
        } catch (error) {
            failures += 1;
            console.error('  FAIL  ' + name + ': ' + error.message);
        }
    }

    console.log(`\n${failures ? 'FAIL' : 'PASS'}: ${checks.length - failures}/${checks.length} identity rule checks`);
    if (failures) process.exitCode = 1;
})();
