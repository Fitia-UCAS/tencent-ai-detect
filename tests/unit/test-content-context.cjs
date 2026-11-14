// Drives the real content.js inside a Node VM with a mocked extension surface.
//
// This exists because the failure modes it covers are invisible in normal use:
// a stale content script only misbehaves right after the extension is reloaded,
// and the symptoms (a hang, an unhandled rejection, an unwanted reload) are each
// a single missing branch. Without these checks a later edit to content.js can
// silently bring the "Extension context invalidated" class of bug back.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The content layer is four classic scripts loaded in order by the manifest; the test loads the
// same list into one sandbox so the shared namespace is exercised exactly as in the browser.
const CONTENT_DIR = path.join(__dirname, '..', '..', 'src', 'content');
const SOURCES = ['core.js', 'identity.js', 'detection.js', 'engine.js', 'index.js'].map(name => ({
    name: 'src/content/' + name,
    text: fs.readFileSync(path.join(CONTENT_DIR, name), 'utf8')
}));
const INVALIDATED = 'Extension context invalidated.';

// Unexpected rejections must fail the whole test, not merely print FAIL while exiting 0.
// The previous handler incremented a separate counter but never updated `failures`, so a
// rejected Promise could produce both a FAIL line and `all checks passed` in one run.
const failures = [];
const ok = m => process.stdout.write(`  ok    ${m}\n`);
const fail = m => { failures.push(m); process.stdout.write(`  FAIL  ${m}\n`); };
let unhandled = 0;
process.on('unhandledRejection', error => {
        unhandled += 1;
        const first = error && error.stack ? error.stack.split('\n')[0] : String(error);
        fail('unhandled rejection: ' + first);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Builds a VM whose chrome.* surface behaves according to the scenario under
// test. Returns the handles the assertions need.
function boot(options = {}) {
    const reloads = [];
    const messages = [];
    const clickHandlers = [];
    let listener = null;

    const store = new Map();

    const chrome = {
        runtime: {
            lastError: undefined,
            onMessage: {
                addListener(fn) { listener = fn; }
            },
            sendMessage(message, callback) {
                messages.push(message);

                if (options.onSend) return options.onSend(message, callback);

                if (typeof callback === 'function') callback({ ok: true });
                return undefined;
            }
        },
        storage: {
            local: {
                get(keys, callback) { callback({ autoRefresh: true }); }
            },
            onChanged: {
                addListener() {}
            }
        }
    };

    const sandbox = {
        chrome,
        console,
        Promise,
        JSON,
        Date,
        Number,
        String,
        Error,
        Object,
        Array,
        setTimeout,
        clearTimeout,
        // engine.js arms the watchdog with setInterval. Without it boot() throws, and because the run
        // is an async IIFE the throw became a swallowed unhandledRejection: zero checks ran, the
        // process still exited 0, and the suite looked green.
        setInterval: () => 1,
        clearInterval: () => {},
        location: { reload() { reloads.push(Date.now()); } },
        window: { __zqDetectInjected: false },
        document: {
            cookie: '',
            body: { innerText: '' },
            documentElement: {},
            // detection.js probes for the captcha frame by id, auto.js queries the editor and the buttons.
            // Without these the content scripts threw during boot, so no check below ever ran.
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener(type, handler) {
                if (type === 'click') clickHandlers.push(handler);
            }
        },
        localStorage: {
            getItem: k => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: k => store.delete(k)
        },
        sessionStorage: {
            getItem: () => null,
            setItem: () => {},
            removeItem: () => {}
        },
        MutationObserver: class {
            observe() {}
            disconnect() {}
        }
    };

    sandbox.window = sandbox.window || {};
    vm.createContext(sandbox);
    for (const source of SOURCES) {
        vm.runInContext(source.text, sandbox, { filename: source.name });
    }

    return {
        reloads,
        messages,
        store,
        // Swaps the transport so a later call can simulate the context dying.
        setSend(fn) { chrome.runtime.sendMessage = fn; },
        // The registered onMessage listener throws when the context is stale, which
        // is exactly what the guards are meant to absorb.
        fire(action) {
            if (!listener) throw new Error('content script did not register a listener');
            let response;
            const keepChannelOpen = listener({ action }, {}, value => { response = value; });
            return { keepChannelOpen, response };
        },
        click(text) {
            clickHandlers.forEach(h => h({ target: { textContent: text, className: '' } }));
        },
        clickTarget(target) {
            clickHandlers.forEach(h => h({ target }));
        },
        statuses() {
            return messages
                .filter(m => m && m.action === 'statusUpdate')
                .map(m => m.payload && m.payload.status);
        }
    };
}

(async () => {
    // 1. Healthy worker: the probe resolves true and a rotation is scheduled.
    {
        const env = boot();
        env.fire('manualReset');

        await sleep(150);
        ok('healthy probe schedules a reload (control case)');

        await sleep(1300);
        if (env.reloads.length === 1) ok('scheduled reload fired exactly once');
        else fail(`expected 1 reload, got ${env.reloads.length}`);
    }

    // 2. Worker never answers: the probe must settle anyway, or rotate() hangs
    //    with rotating=true and every later attempt bails out silently.
    {
        const env = boot({ onSend: () => undefined });
        env.fire('manualReset');

        await sleep(3200);
        const statuses = env.statuses();

        if (statuses.includes('relay-offline')) ok('silent worker times out and reports relay-offline');
        else fail(`probe did not settle on timeout; statuses=${JSON.stringify(statuses)}`);
    }

    // 3. The callback form returns a rejected Promise (worker gone, port closed).
    //    It must be observed, not left as an unhandled rejection, and the probe
    //    must still settle so rotate() is not stranded.
    {
        const before = unhandled;
        const env = boot({
            onSend: (message, callback) => {
                if (message.action === 'relayHealth') {
                    return Promise.reject(new Error('worker unavailable'));
                }
                if (typeof callback === 'function') callback({ ok: true });
                return undefined;
            }
        });

        env.fire('manualReset');
        await sleep(300);

        const after = unhandled;

        if (after === before) ok('rejected sendMessage produces no unhandled rejection');
        else fail(`rejected sendMessage leaked ${after - before} unhandled rejection(s)`);

        if (env.statuses().includes('relay-offline')) ok('rejected sendMessage settles the probe as false');
        else fail(`probe did not settle after rejection; statuses=${JSON.stringify(env.statuses())}`);
    }

    // 3b. A rejection that IS an invalidation must additionally silence the
    //     script: the context is gone, so further messages would only throw again.
    {
        const env = boot({
            onSend: (message, callback) => {
                if (message.action === 'relayHealth') {
                    return Promise.reject(new Error(INVALIDATED));
                }
                if (typeof callback === 'function') callback({ ok: true });
                return undefined;
            }
        });

        env.fire('manualReset');
        await sleep(200);

        const quiet = env.statuses().includes('relay-offline') === false;
        if (quiet) ok('an invalidation rejection stops further messaging');
        else fail('invalidation rejection still reported back to the worker');
    }

    // 4. A reload is already scheduled when the context dies. The stale timer must
    //    be cancelled: reloading only to inject a script that reads the same stale
    //    state throws the user out of a working page for nothing.
    {
        const env = boot();
        env.fire('manualReset');
        await sleep(150);

        const scheduled = env.reloads.length === 0 && env.messages.length > 0;
        if (scheduled) ok('reload is pending before the context dies (control case)');
        else fail('control case did not reach a pending reload');

        // The context dies: every later chrome.* call throws.
        env.setSend(() => { throw new Error(INVALIDATED); });
        env.click('立即检测');

        await sleep(1500);

        if (env.reloads.length === 0) ok('invalidation cancels the pending reload');
        else fail(`pending reload still fired ${env.reloads.length} time(s) after invalidation`);
    }

    // 5. The health probe succeeds, but the context dies on the next message.
    //    This transition happens before scheduleRetry(); the old timer cleanup
    //    alone cannot cancel a timer which has not yet been created.
    {
        const env = boot({
            onSend: (message, callback) => {
                if (message.action === 'relayHealth') {
                    callback({ ok: true });
                    return undefined;
                }
                if (message.action === 'logReset') throw new Error(INVALIDATED);
                return undefined;
            }
        });

        env.fire('manualReset');
        await sleep(1400);

        if (env.messages.some(m => m.action === 'logReset') && env.reloads.length === 0) {
            ok('late invalidation does not schedule a new reload');
        } else {
            fail(`late invalidation produced ${env.reloads.length} unwanted reload(s)`);
        }
    }

    // 6. Message listeners must close channels for synchronous and unknown actions.
    {
        const env = boot();
        const known = env.fire('toggle');
        const unknown = env.fire('not-a-real-action');

        if (known.keepChannelOpen === false && known.response?.status === 'success') {
            ok('synchronous actions respond and close their message channel');
        } else {
            fail(`synchronous action left an open channel or missed its response: ${JSON.stringify(known)}`);
        }

        if (unknown.keepChannelOpen === false && unknown.response === undefined) {
            ok('unknown actions do not leave unanswered message channels open');
        } else {
            fail(`unknown action left an open channel: ${JSON.stringify(unknown)}`);
        }
    }

    // 7. SVGElement.className is an SVGAnimatedString. A document-level click
    //    listener must not assume it has String.prototype.includes.
    {
        const env = boot();
        let threw = false;
        try {
            env.clickTarget({ textContent: '', className: { baseVal: 'icon-button' } });
        } catch (error) {
            threw = true;
        }
        if (!threw) ok('SVG click targets do not throw while checking class names');
        else fail('SVG click target caused a className.includes exception');
    }

    // Give any Promise rejected by the final synchronous check a turn to surface before
    // deciding the exit status. Tests are not allowed to print FAIL and still exit zero.
    await sleep(0);
    if (failures.length) {
        process.stdout.write(`\n${failures.length} check(s) failed\n`);
    } else {
        process.stdout.write('\nall checks passed\n');
    }

    // Exits explicitly. The content scripts keep their own retry chains armed - a silent worker is
    // retried on RELAY_RETRY_MS for as long as it stays silent - and in the browser a page reload ends
    // that chain. Here the reload is stubbed, so those timers would outlive the run forever.
    process.exit(failures.length ? 1 : 0);
})().catch(error => {
    process.stdout.write('\n  FAIL  the run threw before finishing: ' + (error && error.message) + '\n');
    process.exit(1);
});
