// The header rule is installed asynchronously, and "the update was accepted" is not "the rules are
// live". These checks drive the real module with a fake declarativeNetRequest so each failure mode
// is reproducible without a browser.
//
// The rules are per tab, so every check names a tab. The isolation checks at the end are the ones
// that cover the defect this replaced: one global rule set meant a second tab silently took the
// address away from the first, and the detection was refused with "Invalid request".
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = pathToFileURL(path.join(__dirname, '../../src/background/header-rules.js')).href;

const TAB_A = 21;
const TAB_B = 22;

// A fake that keeps the session rule list and can be told to fail, lag, or report rules that differ
// from the ones it was given.
function fakeChrome({ failUpdate = false, failRead = false, dropRule = false, mutateValue = null, stripTabIds = false, lag = 0, hangUpdate = false, hangRead = false } = {}) {
    // hangUpdate / hangRead model a browser call that simply never answers - the case where an
    // await would stay pending forever and take the queue with it. They are mutable so a check can
    // hang one call and then let the next one through.
    const state = { rules: [], updates: 0, reads: 0, order: [], hangUpdate, hangRead, tabs: [TAB_A, TAB_B] };

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
            tabs: {
                query(query, callback) {
                    settle(callback, state.tabs.map(id => ({ id })));
                }
            },
            declarativeNetRequest: {
                updateSessionRules(changes, callback) {
                    state.updates += 1;
                    // A removal-only call carries no addRules; the order log has to stay readable for
                    // both, or the fake throws before it ever calls back.
                    const added = changes.addRules || [];
                    state.order.push('update:' + (added.length
                        ? added[0].action.requestHeaders[0].value
                        : '-remove:' + changes.removeRuleIds.join(',')));

                    // Never calls back: the caller must time out rather than wait forever.
                    if (state.hangUpdate) return;

                    if (failUpdate) {
                        this._chrome.runtime.setLastError('rule update refused');
                        callback();
                        this._chrome.runtime.setLastError(null);
                        return;
                    }

                    const next = state.rules.filter(rule => !changes.removeRuleIds.includes(rule.id));
                    for (const rule of added) {
                        if (dropRule && rule.id === added[added.length - 1].id) continue;
                        const copy = JSON.parse(JSON.stringify(rule));
                        if (mutateValue) copy.action.requestHeaders[0].value = mutateValue;
                        if (stripTabIds) delete copy.condition.tabIds;
                        next.push(copy);
                    }
                    state.rules = next;
                    settle(callback, undefined);
                },
                getSessionRules(callback) {
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
    return { fake, mod, identity: mod.createHeaderRules({ chrome: fake.chrome, opTimeoutMs }) };
}

// --- the defect this replaces -------------------------------------------------

check('apply only reports success after the rules read back', async () => {
    const { fake, identity } = await load();
    const applied = await identity.apply('112.80.1.2', TAB_A);

    assert.equal(applied, true, 'a verified update must report success');
    assert.equal(identity.currentFor(TAB_A), '112.80.1.2');
    assert.ok(fake.state.reads >= 1, 'the rules must be read back before answering');
});

check('a refused update never reports success', async () => {
    const { identity } = await load({ failUpdate: true });
    const applied = await identity.apply('112.80.1.2', TAB_A);

    assert.equal(applied, false, 'a failed update must not look successful');
    assert.equal(identity.currentFor(TAB_A), null, 'a tab must not describe an install that did not happen');
});

check('an update that lands different rules is not success', async () => {
    const { identity } = await load({ mutateValue: '9.9.9.9' });
    const applied = await identity.apply('112.80.1.2', TAB_A);

    assert.equal(applied, false, 'the rules carry another address, so this install failed');
    assert.equal(identity.currentFor(TAB_A), null);
});

check('a partial rule set is not success', async () => {
    const { identity } = await load({ dropRule: true });
    const applied = await identity.apply('112.80.1.2', TAB_A);

    assert.equal(applied, false, 'one domain left on the old address means the set is not coherent');
    assert.equal(identity.currentFor(TAB_A), null);
});

check('a rule that loses its tab scope is not success', async () => {
    // The address alone is not proof: a rule without tabIds applies to every tab, which is exactly
    // the global behaviour these rules exist to avoid.
    const { identity } = await load({ stripTabIds: true });

    assert.equal(await identity.apply('112.80.1.2', TAB_A), false, 'an unscoped rule must not count');
    assert.equal(identity.currentFor(TAB_A), null);
});

check('an unreadable rule set is not success', async () => {
    const { identity } = await load({ failRead: true });

    assert.equal(await identity.apply('112.80.1.2', TAB_A), false, 'unverified is not verified');
});

// --- the ordering guarantees --------------------------------------------------

check('a second apply waits for the first to finish', async () => {
    const { fake, identity } = await load({ lag: 5 });

    await Promise.all([
        identity.apply('112.80.1.2', TAB_A),
        identity.apply('112.80.1.3', TAB_A)
    ]);

    assert.deepEqual(fake.state.order.filter(step => step.startsWith('update:')),
        ['update:112.80.1.2', 'update:112.80.1.3'],
        'updates must run in the order they were requested, not interleaved');
    assert.equal(identity.currentFor(TAB_A), '112.80.1.3', 'the last requested address must be the live one');
});

check('the earlier of two racing updates cannot win', async () => {
    const { identity } = await load({ lag: 8 });

    const first = identity.apply('112.80.1.2', TAB_A);
    const second = identity.apply('112.80.1.3', TAB_A);
    await Promise.all([first, second]);

    // Without serialisation the slower first update could resolve last and leave 112.80.1.2 live.
    assert.equal(identity.currentFor(TAB_A), '112.80.1.3');
});

check('a repeated address is answered without touching the rules', async () => {
    const { fake, identity } = await load();

    await identity.apply('112.80.1.2', TAB_A);
    const updatesAfterFirst = fake.state.updates;
    assert.equal(await identity.apply('112.80.1.2', TAB_A), true, 'the same address is already live');
    assert.equal(fake.state.updates, updatesAfterFirst, 'no second update should be sent');
});

check('a rejected address never reaches the rules', async () => {
    const { fake, identity } = await load();

    assert.equal(await identity.apply('1.2.3.4\r\nX-Injected: 1', TAB_A), false, 'CRLF must be refused');
    assert.equal(await identity.apply('', TAB_A), false);
    assert.equal(await identity.apply(null, TAB_A), false);
    assert.equal(fake.state.updates, 0, 'nothing may be installed for an invalid address');
});

// --- per-tab isolation --------------------------------------------------------

check('a message with no sender tab is refused', async () => {
    // An unscoped rule applies everywhere, so it is refused rather than installed globally.
    const { fake, identity } = await load();

    assert.equal(await identity.apply('112.80.1.2'), false, 'a missing tab cannot be scoped');
    assert.equal(await identity.apply('112.80.1.2', undefined), false);
    assert.equal(await identity.apply('112.80.1.2', null), false);
    assert.equal(await identity.apply('112.80.1.2', '7'), false, 'a string is not a tab id');
    assert.equal(fake.state.updates, 0, 'nothing unscoped may be installed');
});

check('two tabs keep their own address', async () => {
    const { identity } = await load();

    assert.equal(await identity.apply('112.80.1.2', TAB_A), true);
    assert.equal(await identity.apply('39.156.1.1', TAB_B), true);

    assert.equal(identity.currentFor(TAB_A), '112.80.1.2',
        'a second tab must not take the first one\'s address');
    assert.equal(identity.currentFor(TAB_B), '39.156.1.1');
    assert.equal(identity.size, 2, 'both tabs hold a confirmed address');
});

check('each tab\'s rules name that tab and carry its own address', async () => {
    const { fake, identity } = await load();

    await identity.apply('112.80.1.2', TAB_A);
    await identity.apply('39.156.1.1', TAB_B);

    const byTab = new Map();
    for (const rule of fake.state.rules) {
        const tabIds = rule.condition.tabIds;
        assert.ok(Array.isArray(tabIds) && tabIds.length === 1, 'a rule must name exactly one tab');
        if (!byTab.has(tabIds[0])) byTab.set(tabIds[0], []);
        byTab.get(tabIds[0]).push(rule);
    }

    assert.equal(byTab.get(TAB_A).length, 3, 'one rule per domain for the first tab');
    assert.equal(byTab.get(TAB_B).length, 3, 'and a separate set for the second');
    assert.ok(byTab.get(TAB_A).every(rule => rule.action.requestHeaders[0].value === '112.80.1.2'),
        'the first tab must keep its own address');
    assert.ok(byTab.get(TAB_B).every(rule => rule.action.requestHeaders[0].value === '39.156.1.1'),
        'the second tab must not overwrite it');
});

check('the two tabs use different rule ids', async () => {
    // Shared ids are how a global set would look: the second install would replace the first.
    const { fake, identity } = await load();

    await identity.apply('112.80.1.2', TAB_A);
    const first = fake.state.rules.map(rule => rule.id).sort((a, b) => a - b);

    await identity.apply('39.156.1.1', TAB_B);
    const all = fake.state.rules.map(rule => rule.id).sort((a, b) => a - b);

    assert.equal(all.length, 6, 'both tabs\' rules must be present at once');
    assert.equal(all.filter(id => first.includes(id)).length, 3,
        'the second tab must not reuse the first tab\'s ids');
});

check('closing a tab frees its rules and slot for the next one', async () => {
    const { fake, identity } = await load();

    await identity.apply('112.80.1.2', TAB_A);
    const firstIds = fake.state.rules.map(rule => rule.id).sort((a, b) => a - b);

    assert.equal(await identity.removeTab(TAB_A), true);
    assert.equal(fake.state.rules.length, 0, 'the closed tab\'s rules must go');
    assert.equal(identity.currentFor(TAB_A), null, 'and its entry with them');

    await identity.apply('39.156.1.1', TAB_B);
    const nextIds = fake.state.rules.map(rule => rule.id).sort((a, b) => a - b);
    assert.deepEqual(nextIds, firstIds, 'the freed slot must be handed to the next tab');
});

check('removing a tab that holds nothing is harmless', async () => {
    const { identity } = await load();

    assert.equal(await identity.removeTab(999), true);
    assert.equal(await identity.removeTab(undefined), false, 'a missing tab id is refused');
});

// --- service worker restart ---------------------------------------------------

check('sync adopts the rules a previous worker installed', async () => {
    const { fake, identity, mod } = await load();

    // Another worker installed these before this one started.
    fake.state.rules = mod.buildIdentityRules('112.80.1.2', TAB_A, 0);

    assert.equal(identity.currentFor(TAB_A), null, 'fresh module state starts out empty');
    assert.equal(await identity.sync(), 1, 'sync must adopt what the browser holds');
    assert.equal(identity.currentFor(TAB_A), '112.80.1.2', 'and attribute it to its tab');
});

check('sync adopts one entry per tab', async () => {
    const { fake, identity, mod } = await load();

    fake.state.rules = [
        ...mod.buildIdentityRules('112.80.1.2', TAB_A, 0),
        ...mod.buildIdentityRules('39.156.1.1', TAB_B, 1)
    ];

    assert.equal(await identity.sync(), 2);
    assert.equal(identity.currentFor(TAB_A), '112.80.1.2');
    assert.equal(identity.currentFor(TAB_B), '39.156.1.1');
});

check('after sync, the same address is not reinstalled', async () => {
    const { fake, identity, mod } = await load();
    fake.state.rules = mod.buildIdentityRules('112.80.1.2', TAB_A, 0);
    await identity.sync();

    const before = fake.state.updates;
    assert.equal(await identity.apply('112.80.1.2', TAB_A), true);
    assert.equal(fake.state.updates, before, 'a restart must not force a redundant update');
});

check('after sync, a different address still gets installed', async () => {
    const { fake, identity, mod } = await load();
    fake.state.rules = mod.buildIdentityRules('112.80.1.2', TAB_A, 0);
    await identity.sync();

    assert.equal(await identity.apply('112.80.1.3', TAB_A), true);
    assert.equal(identity.currentFor(TAB_A), '112.80.1.3');
});

check('sync with no rules leaves the module empty rather than guessing', async () => {
    const { identity } = await load();
    assert.equal(await identity.sync(), 0);
    assert.equal(identity.size, 0);
});

check('sync does not adopt an unscoped rule', async () => {
    // A rule left by an older build has no tabIds. Adopting it would mean believing an address is
    // tab-scoped when it applies to everything.
    const { fake, identity, mod } = await load();
    fake.state.rules = mod.buildIdentityRules('112.80.1.2', TAB_A, 0)
        .map(rule => { delete rule.condition.tabIds; return rule; });

    assert.equal(await identity.sync(), 0, 'an unscoped rule is not adopted');
    assert.equal(identity.size, 0);
});

check('sync drops rules whose tab no longer exists', async () => {
    const { fake, identity, mod } = await load();
    fake.state.rules = mod.buildIdentityRules('112.80.1.2', TAB_A, 0);
    fake.state.tabs = [TAB_B];

    assert.equal(await identity.sync(), 0, 'a rule for a closed tab must not be adopted');
    assert.equal(fake.state.rules.length, 0, 'and it must be removed from the ruleset');
});

check('sync keeps the rules of an open tab', async () => {
    const { fake, identity, mod } = await load();
    fake.state.rules = mod.buildIdentityRules('112.80.1.2', TAB_A, 0);
    fake.state.tabs = [TAB_A];

    assert.equal(await identity.sync(), 1);
    assert.equal(fake.state.rules.length, 3, 'an open tab keeps its rules');
});

// --- reading rules back -------------------------------------------------------

check('a coherent rule set reports its address', async () => {
    const mod = await import(MODULE);
    assert.equal(mod.addressFromRules(mod.buildIdentityRules('112.80.1.2', TAB_A, 0)), '112.80.1.2');
});

check('a mixed rule set reports nothing', async () => {
    const mod = await import(MODULE);
    const rules = mod.buildIdentityRules('112.80.1.2', TAB_A, 0);
    rules[1].action.requestHeaders[0].value = '9.9.9.9';

    assert.equal(mod.addressFromRules(rules), null, 'two addresses cannot both be the identity');
});

check('an unrelated rule is ignored', async () => {
    const mod = await import(MODULE);
    const rules = mod.buildIdentityRules('112.80.1.2', TAB_A, 0);
    rules.push({ id: 9999, priority: 1, action: { type: 'block' }, condition: { tabIds: [TAB_B] } });

    assert.equal(mod.addressFromRules(rules), '112.80.1.2', 'other tabs\' rules must not break the check');
});

check('slot ids round-trip through the slot they belong to', async () => {
    const mod = await import(MODULE);

    for (const slot of [0, 1, 7, 63]) {
        assert.equal(mod.slotFromRuleIds(mod.slotRuleIds(slot)), slot, 'slot ' + slot + ' must round-trip');
    }

    assert.equal(mod.slotFromRuleIds([1, 2]), null, 'an incomplete set belongs to no slot');
    assert.equal(mod.slotFromRuleIds([2, 3, 4]), null, 'ids off the slot boundary belong to none');
});

// --- serialization and liveness ----------------------------------------------

check('sync waits behind a pending apply instead of racing it', async () => {
    // A worker restart runs sync(); a page publishing at the same moment runs apply(). If sync's
    // read completes after the apply confirmed the new address, it puts the old one back and the
    // next publish skips an update that was actually needed.
    const { fake, identity } = await load({ lag: 5 });

    const applying = identity.apply('112.80.1.2', TAB_A);
    const syncing = identity.sync();
    await Promise.all([applying, syncing]);

    // The ordering is the assertion: unserialized, sync's read runs first, sees the pre-update
    // rules, and resolves after the apply has already confirmed the new address.
    assert.deepEqual(fake.state.order, ['update:112.80.1.2', 'read', 'read'],
        'the sync read must wait for the update it would otherwise race');
    assert.equal(identity.currentFor(TAB_A), '112.80.1.2',
        'the address the apply confirmed must survive a sync that started earlier');
});

check('an apply that never answers fails closed instead of stalling the queue', async () => {
    const { fake, identity } = await load({ hangUpdate: true });

    const hung = await identity.apply('112.80.1.2', TAB_A);
    assert.equal(hung, false, 'an unanswered update is unverified, so it is a failure');
    assert.equal(identity.currentFor(TAB_A), null, 'and it must not be recorded as installed');

    // The queue has to still be usable afterwards, or one stuck call disables every later publish.
    fake.state.hangUpdate = false;
    assert.equal(await identity.apply('112.80.1.3', TAB_A), true, 'a later update must still go through');
    assert.equal(identity.currentFor(TAB_A), '112.80.1.3');
});

check('a rule read that never answers does not swallow the next update', async () => {
    const { fake, identity } = await load({ hangRead: true });

    assert.equal(await identity.sync(), 0, 'an unreadable rule set leaves the module empty');
    assert.equal(identity.size, 0);

    fake.state.hangRead = false;
    assert.equal(await identity.apply('112.80.1.2', TAB_A), true);
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
