// The page must not go permanently silent when the header rule is refused.
//
// A refused rule means the captcha ticket is issued for the real address while the socket carries
// the synthetic one, and the server refuses that pairing every time - so the click is skipped. But
// skipping forever with no visible reason is its own failure: the page looks broken and nothing
// brings it back. These checks pin the two halves: the refusal is reported, and it is retried a
// bounded number of times rather than once.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../../src/content/identity.js'), 'utf8');

function load({ responses = [] } = {}) {
    const sends = [];
    const statuses = [];
    const timers = [];
    let nextTimer = 1;
    let answerIndex = 0;

    const ZQ = {
        state: { contextAlive: true, identityConfirmed: null },
        send: message => {
            sends.push(message);
            if (message.action !== 'setIdentity') return Promise.resolve(null);

            const answer = responses[Math.min(answerIndex, responses.length - 1)];
            answerIndex += 1;
            return Promise.resolve(answer);
        },
        currentState: status => ({ status }),
        reportState: state => statuses.push(state.status)
    };

    const sandbox = {
        window: { __zq: ZQ },
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        // Timers run for real (as a zero-delay task) and are also recorded, because publishIdentity
        // itself waits on a timer for its internal retry - a timer that only recorded the callback
        // would leave that promise pending forever and the check would hang.
        setTimeout: (fn, ms) => {
            timers.push({ ms });
            const id = nextTimer++;
            return setTimeout(fn, 0);
        },
        clearTimeout: () => {},
        console
    };
    sandbox.window.window = sandbox.window;

    vm.runInNewContext(SOURCE, sandbox, { filename: 'identity.js' });

    return {
        ZQ, sends, statuses, timers,
        // Timers already run on their own; this just lets their chained promises settle.
        fireTimers: async () => {
            for (let i = 0; i < 20; i += 1) {
                await new Promise(resolve => setTimeout(resolve, 5));
            }
        },
        setAttempts: () => sends.filter(message => message.action === 'setIdentity').length
    };
}

const checks = [];
const check = (name, run) => checks.push([name, run]);

check('a confirmed rule reports nothing and retries nothing', async () => {
    const page = load({ responses: [{ status: 'success' }] });
    await page.ZQ.publishIdentity('112.80.1.2');

    assert.equal(page.ZQ.state.identityConfirmed, true);
    assert.deepEqual(page.statuses, [], 'a working rule needs no warning');
    assert.equal(page.timers.length, 0, 'nothing to retry');
});

check('a refused rule is reported so the page does not look broken', async () => {
    const page = load({ responses: [{ status: 'ignored' }] });
    await page.ZQ.publishIdentity('112.80.1.2');

    assert.equal(page.ZQ.state.identityConfirmed, false);
    assert.deepEqual(page.statuses, ['identity-unconfirmed'],
        'the panel has to say why nothing is being detected');
});

check('a refused rule is retried instead of giving up for the load', async () => {
    const page = load({ responses: [{ status: 'ignored' }] });
    await page.ZQ.publishIdentity('112.80.1.2');

    const before = page.setAttempts();
    await page.fireTimers();

    assert.ok(page.setAttempts() > before, 'a transient refusal must be retried');
});

check('the retry stops once the rule is confirmed', async () => {
    // First answer refused, the rest accepted - the common case of a worker still starting.
    const page = load({ responses: [{ status: 'ignored' }, { status: 'success' }] });
    await page.ZQ.publishIdentity('112.80.1.2');
    await page.fireTimers();

    assert.equal(page.ZQ.state.identityConfirmed, true, 'the retry must be able to succeed');
});

check('retries are bounded, so a permanent refusal stops trying', async () => {
    const page = load({ responses: [{ status: 'ignored' }] });
    await page.ZQ.publishIdentity('112.80.1.2');
    await page.fireTimers();

    const attempts = page.setAttempts();
    // Each publish can carry one internal retry plus the paced one, so the bound is on the paced
    // retries; what matters is that it stops rather than running forever.
    assert.ok(attempts <= 12, 'retries must not be unbounded, saw ' + attempts + ' attempts');
});

check('a dead context stops retrying', async () => {
    const page = load({ responses: [{ status: 'ignored' }] });
    await page.ZQ.publishIdentity('112.80.1.2');

    const before = page.setAttempts();
    page.ZQ.state.contextAlive = false;
    await page.fireTimers();

    assert.equal(page.setAttempts(), before, 'a reloaded-away script must not keep messaging');
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

    console.log(`\n${failures ? 'FAIL' : 'PASS'}: ${checks.length - failures}/${checks.length} identity retry checks`);
    if (failures) process.exitCode = 1;
})();
