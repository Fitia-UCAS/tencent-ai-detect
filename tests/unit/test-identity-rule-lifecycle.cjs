// The header rule is installed asynchronously, and "the update was accepted" is not "the rules are
// live". These checks drive the real module with a fake declarativeNetRequest so each failure mode
// is reproducible without a browser.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = pathToFileURL(path.join(__dirname, '../../src/background/identity.js')).href;

// A fake that keeps the dynamic rule list and can be told to fail, lag, or report rules that differ
// from the ones it was given.
function fakeChrome({ failUpdate = false, failRead = false, dropRule = false, mutateValue = null, lag = 0 } = {}) {
    const state = { rules: [], updates: 0, reads: 0, order: [] };

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
    return { fake, mod, identity: mod.createIdentityRules({ chrome: fake.chrome }) };
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

    assert.deepEqual(fake.state.order, ['update:112.80.1.2', 'update:112.80.1.3'],
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
