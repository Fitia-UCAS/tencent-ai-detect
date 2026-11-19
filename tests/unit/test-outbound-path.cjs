// Records which way the relay leaves the machine, so a refusal can be attributed.
//
// The question this exists for: a ticket comes back `code 21 "diff"`, the page prints "Invalid
// request", and there is no way to tell whether the proxy client was on at that moment. The proxy's
// own log records only its periodic guard refresh, minutes away from any press - measured: of the 22
// refusals on this machine, the nearest proxy log line was over three minutes away for most of them,
// while 33 of 84 successes sat within one minute of one. The two series do not line up, so the proxy
// log cannot answer it.
//
// What is pinned here is the whole chain: the relay names its path on /health, the probe notices a
// change and publishes it exactly once, and every trail entry carries the path plus the age of the
// reading that produced it.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = pathToFileURL(
    path.resolve(__dirname, '..', '..', 'src', 'background', 'relay-health.js')
).href;

const checks = [];
const check = (name, fn) => {
    try {
        fn();
        checks.push(true);
        console.log('  ok    ' + name);
    } catch (error) {
        checks.push(false);
        console.log('  FAIL  ' + name + ' - ' + error.message);
    }
};

// The probe only needs a fetch that answers with whatever body the case wants.
function makeProbe(bodies, { clock = { at: 1000 } } = {}) {
    let index = 0;
    const published = [];
    const onlineFlags = [];

    const relayState = {
        set(value) { onlineFlags.push(value); return value; },
        isHealthy: body => !!body && body.ok === true,
        isOnline: () => onlineFlags[onlineFlags.length - 1] === true
    };

    const fetchImpl = async () => ({
        json: async () => {
            const body = bodies[Math.min(index, bodies.length - 1)];
            index += 1;
            return body;
        }
    });

    // Imported lazily so the module is loaded once, after the harness is built.
    return { bodies, fetchImpl, relayState, published, onlineFlags, clock };
}

(async () => {
    const { createRelayHealth } = await import(MODULE);

    // --- the path starts unknown, not direct ---------------------------------

    await (async () => {
        const clock = { at: 1000 };
        const seen = [];
        const harness = makeProbe([{ ok: true, service: 'zq-local-relay-v1' }], { clock });
        const health = createRelayHealth({
            fetchImpl: harness.fetchImpl,
            url: 'http://127.0.0.1:9420/health',
            relayState: harness.relayState,
            timeoutMs: 1500,
            publishOutbound: (next, before) => seen.push([before, next]),
            now: () => clock.at
        });

        check('before the relay answers, the path is unknown - not direct', () => {
            assert.equal(health.outbound().path, 'unknown');
            assert.equal(health.outbound().at, 0);
        });

        await health.ping();

        check('a body without a path leaves the reading unknown instead of guessing', () => {
            assert.equal(health.outbound().path, 'unknown');
            assert.deepEqual(seen, []);
        });
    })();

    // --- one publish per change ----------------------------------------------

    await (async () => {
        const clock = { at: 1000 };
        const seen = [];
        const harness = makeProbe([
            { ok: true, outbound: 'direct' },
            { ok: true, outbound: 'direct' },
            { ok: true, outbound: '127.0.0.1:7897' },
            { ok: true, outbound: '127.0.0.1:7897' },
            { ok: true, outbound: 'direct' }
        ], { clock });

        const health = createRelayHealth({
            fetchImpl: harness.fetchImpl,
            url: 'http://127.0.0.1:9420/health',
            relayState: harness.relayState,
            timeoutMs: 1500,
            publishOutbound: (next, before) => seen.push([before, next]),
            now: () => clock.at
        });

        await health.ping();
        await health.ping();
        clock.at = 61000;
        await health.ping();
        await health.ping();
        clock.at = 121000;
        await health.ping();

        check('the first reading is a starting point, not a transition', () => {
            assert.equal(seen[0] && seen[0][0], 'unknown');
        });

        check('a repeat reading publishes nothing', () => {
            assert.deepEqual(seen, [
                ['unknown', 'direct'],
                ['direct', '127.0.0.1:7897'],
                ['127.0.0.1:7897', 'direct']
            ]);
        });

        check('the change is reported with both ends, so the log line reads as a move', () => {
            assert.deepEqual(seen[1], ['direct', '127.0.0.1:7897']);
        });
    })();

    // --- the reading carries its own age -------------------------------------

    await (async () => {
        const clock = { at: 5000 };
        const harness = makeProbe([{ ok: true, outbound: '127.0.0.1:7897' }], { clock });
        const health = createRelayHealth({
            fetchImpl: harness.fetchImpl,
            url: 'http://127.0.0.1:9420/health',
            relayState: harness.relayState,
            timeoutMs: 1500,
            publishOutbound: () => {},
            now: () => clock.at
        });

        await health.ping();
        check('the reading is dated from when it arrived', () => {
            assert.equal(health.outbound().at, 5000);
        });

        clock.at = 65000;
        await health.ping();
        check('a later reading moves the date forward even though the path did not change', () => {
            assert.equal(health.outbound().at, 65000);
            assert.equal(health.outbound().path, '127.0.0.1:7897');
        });
    })();

    // --- an unreachable relay does not silently rewrite the last answer ------

    await (async () => {
        let fail = false;
        const seen = [];
        const published = { ok: true, outbound: '127.0.0.1:7897' };

        const fetchImpl = async () => {
            if (fail) throw new Error('ECONNREFUSED');
            return { json: async () => published };
        };

        const onlineFlags = [];
        const relayState = {
            set(value) { onlineFlags.push(value); return value; },
            isHealthy: body => !!body && body.ok === true,
            isOnline: () => onlineFlags[onlineFlags.length - 1] === true
        };

        const health = createRelayHealth({
            fetchImpl,
            url: 'http://127.0.0.1:9420/health',
            relayState,
            timeoutMs: 1500,
            publishOutbound: (next, before) => seen.push([before, next]),
            now: () => 1000
        });

        await health.ping();
        fail = true;
        const result = await health.ping();

        check('a dead relay reports offline', () => {
            assert.equal(result, null);
            assert.equal(health.isOnline(), false);
        });

        check('and the last known path is kept, not reset to unknown or direct', () => {
            assert.equal(health.outbound().path, '127.0.0.1:7897');
            assert.deepEqual(seen, [['unknown', '127.0.0.1:7897']]);
        });
    })();

    // --- the relay names its path on /health ---------------------------------

    (() => {
        const fs = require('node:fs');
        const source = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'relay', 'server.cjs'), 'utf8');

        // Only the JSON that is actually sent: the comment above it names the things that must stay
        // out of the body, so searching the whole route would match the intention instead of the code.
        const at = source.indexOf("res.end(JSON.stringify({\n            ok: true,", source.indexOf("req.url === '/health'"));
        const body = at === -1 ? '' : source.slice(at, at + 220);

        check('the relay puts its outbound path in the health body', () => {
            assert.ok(body, 'the health route must end with a JSON body');
            assert.match(body, /outbound:\s*describeProxy\(outbound\.current\(\)\)/,
                'the answer must come from the live watcher, not a value read at startup');
        });

        check('nothing identifying is added to the unauthenticated endpoint', () => {
            assert.ok(body, 'the health route must end with a JSON body');

            for (const forbidden of ['process.pid', 'hostname()', 'availableUses', 'remaining']) {
                assert.ok(!body.includes(forbidden), `${forbidden} must not appear on /health`);
            }

            // Three keys, no more: every extra field on an unauthenticated local endpoint is a field
            // any page that can reach 127.0.0.1 gets to read.
            assert.equal(body.match(/^\s{12}\w+:/gm).length, 3,
                'the body must carry exactly ok, service and outbound');
        });
    })();

    // --- every trail entry is stamped ----------------------------------------

    await (async () => {
        const trailModule = await import(pathToFileURL(
            path.resolve(__dirname, '..', '..', 'src', 'background', 'trail.js')).href);

        const written = [];
        const chrome = { storage: { local: {
            get(key, callback) { callback({}); },
            set(values) { written.push(values); }
        } } };

        const trail = trailModule.createTrail({ chrome, key: 'zqTrail' });
        trail.add(7, 'relay-sent', { bytes: 232 }, null, {
            outbound: '127.0.0.1:7897', outboundAgeMs: 8000
        });
        trail.add(7, 'relay-frame', { bytes: 48 }, null, {
            outbound: 'direct', outboundAgeMs: 500
        });

        // The trail stores on a promise, so the write lands a tick after the call.
        await new Promise(done => setTimeout(done, 20));

        const events = written[written.length - 1].zqTrail[7].events;

        check('each entry carries the path in force at that moment', () => {
            assert.equal(events[0].outbound, '127.0.0.1:7897');
            assert.equal(events[1].outbound, 'direct');
        });

        check('and the age of the reading, so a stale value is not read as that instant', () => {
            assert.equal(events[0].outboundAgeMs, 8000);
            assert.equal(events[1].outboundAgeMs, 500);
        });

        await traceNoStamp(trailModule);
    })();

    async function traceNoStamp({ createTrail }) {
        const written = [];
        const chrome = { storage: { local: {
            get(key, callback) { callback({}); },
            set(values) { written.push(values); }
        } } };

        const trail = createTrail({ chrome, key: 'zqTrail' });
        trail.add(7, 'press', { state: 'ok' });

        await new Promise(done => setTimeout(done, 20));

        const events = written[written.length - 1].zqTrail[7].events;
        check('an entry with no reading is not given a made-up path', () => {
            assert.equal(events[0].outbound, undefined);
        });
    }

    // --- the trail reader prints it beside the event it belongs to ----------

    (() => {
        const fs = require('node:fs');
        const source = fs.readFileSync(
            path.join(__dirname, '..', '..', 'tools', 'diagnostics', 'read-trail.cjs'), 'utf8');

        check('the trail reader prints the path on the event line', () => {
            assert.match(source, /event\.outboundAgeMs/,
                'the reader must show the age, otherwise a stale reading looks current');
            assert.match(source, /' \[' \+ event\.outbound/,
                'the path must be on the same line as the event it describes');
        });
    })();

    // --- the path is a diagnostic, and stays out of the panel -----------------

    (() => {
        const fs = require('node:fs');
        const root = path.join(__dirname, '..', '..', 'src', 'sidepanel');

        check('the panel does not display the outbound path', () => {
            // The panel is the user's controls. A proxy/direct readout there is a diagnostic the user
            // cannot act on, and it crowds out the two things that are actionable - a missing host and
            // the chosen mode. It belongs in the trail and the worker log, which is where it goes.
            for (const name of ['index.html', 'index.js', 'styles.css']) {
                const source = fs.readFileSync(path.join(root, name), 'utf8');
                assert.ok(!/outbound/i.test(source),
                    `${name} must not mention the outbound path`);
            }
        });

        check('the worker keeps the path in its log rather than in storage for the panel', () => {
            const app = fs.readFileSync(
                path.join(__dirname, '..', '..', 'src', 'background', 'app.js'), 'utf8');

            const at = app.indexOf('function publishOutbound');
            assert.ok(at !== -1, 'publishOutbound must exist');

            const body = app.slice(at, at + 400);
            assert.match(body, /log\(/, 'a transition must reach the log ring');
            assert.ok(!/storage/.test(body),
                'and must not be mirrored into storage just to be rendered somewhere');
        });
    })();

    const failed = checks.filter(ok => !ok).length;
    console.log('');
    if (failed) {
        console.error(`${failed}/${checks.length} outbound-path checks failed`);
        process.exitCode = 1;
    } else {
        console.log(`PASS: ${checks.length}/${checks.length} outbound-path checks`);
    }
})().catch(error => {
    console.error(String(error && error.stack || error));
    process.exitCode = 1;
});
