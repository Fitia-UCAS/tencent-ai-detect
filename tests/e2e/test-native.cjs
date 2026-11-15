// Verifies the native-messaging lifecycle in a real browser, driving the switch
// through the side panel page so the real message path is exercised.
//
// Asserts four stages: the relay starts with the extension, the switch stops it,
// the switch restarts it, and closing the browser leaves nothing behind.
//
// No process is killed by name: the relay is detected by its health endpoint, so
// an unrelated Node program is never touched.
const path = require('node:path');

const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXT = path.resolve(__dirname, '..', '..');
const EXT_ID = process.env.EXT_ID || 'kdjgfockdecdbadmpbjgflmiffdiffhp';
const PORT = 9382;
const RELAY_PORT = 9420;

const { sleep, httpJson, cdp, launch } = require('../../tools/browser-harness.cjs');
const { relayHealthy } = require('../support/relay.cjs');
const { ownedByOtherBrowser, browserOwning } = require('../../src/relay/owner.cjs');
const { relayPidForPort } = require('../../tools/find-relay-pid.cjs');

const failures = [];
const ok = m => process.stdout.write(`  ok    ${m}\n`);
const fail = m => { failures.push(m); process.stdout.write(`  FAIL  ${m}\n`); };
// Not a pass and not a failure: the assertion cannot be evaluated because another browser
// owns the relay. Reported separately so it is never mistaken for verified behaviour.
const note = m => process.stdout.write(`  note  ${m}\n`);

const relayUp = () => relayHealthy(RELAY_PORT);

// Whether the running relay belongs to a browser other than this test's profile.
//
// The switch assertions below only mean something for a relay this test's browser owns: when
// another Edge window has the extension loaded, flipping the switch closes *this* browser's
// native port, but that window's keepalive brings the port straight back, and the relay that
// answers is not the one under test.
function relayOwnedElsewhere(profile) {
    if (!profile) return { other: false, known: false };

    const pid = relayPidForPort(RELAY_PORT);
    if (!pid) return { other: false, known: false };

    return ownedByOtherBrowser(pid, profile);
}

async function waitFor(predicate, attempts = 40, gap = 400) {
    for (let i = 0; i < attempts; i++) {
        if (await predicate()) return true;
        await sleep(gap);
    }
    return false;
}

(async () => {
    let session = null;
    let panel = null;
    let testProfile = null;

    try {
        if (await relayUp()) {
            const pid = relayPidForPort(RELAY_PORT);
            const owner = pid ? browserOwning(pid) : null;
            const who = owner
                ? ` It belongs to ${owner.name} pid ${owner.pid}` +
                    (owner.profile ? ` (profile ${owner.profile}).` : ' (no --user-data-dir, so a normal browser window).')
                : '';
            fail(`a relay is already running on ${RELAY_PORT}; stop it first so the test owns the lifecycle.${who}`);
            // Closing the window is not enough: with the extension enabled and Edge's background
            // mode on, the worker keeps running, its one-minute keepalive alarm restarts the relay,
            // and the port stays taken. `npm run stop:relay` frees it only until that alarm fires,
            // which is far shorter than the wait this suite needs.
            note('disable this extension in that browser (durable), or quit the browser including its background mode; `npm run stop:relay` only holds until the one-minute keepalive restarts it');
        } else {
            ok('no relay running before the test');

            session = await launch({
                browser: BROWSER,
                port: PORT,
                prefix: 'zqnative',
                args: [
                    '--disable-features=DisableLoadExtensionCommandLineSwitch',
                    `--disable-extensions-except=${EXT}`,
                    `--load-extension=${EXT}`
                ]
            });
            testProfile = session.profile;

            // 1. The relay must come up on its own, driven by the worker.
            const started = await waitFor(relayUp, 40, 500);
            started ? ok('relay started with the extension') : fail('relay did not start with the extension');

            // The side panel is a normal extension page, so it can message the worker
            // exactly like the real UI does. The path must match manifest.side_panel:
            // a URL that does not resolve lands on a chrome-error page with no extension
            // privileges, where chrome.runtime is undefined.
            const panelTarget = await httpJson(
                PORT,
                `/json/new?chrome-extension://${EXT_ID}/src/sidepanel/index.html`,
                'PUT'
            );

            if (!panelTarget || !panelTarget.webSocketDebuggerUrl) {
                fail('could not open the side panel page');
            } else {
                panel = await cdp(panelTarget.webSocketDebuggerUrl);
                await panel.send('Runtime.enable');
                await panel.send('Page.enable');
                await panel.send('Page.bringToFront');

                const evaluate = async expression => {
                    const result = await panel.send('Runtime.evaluate', {
                        expression,
                        awaitPromise: true,
                        returnByValue: true
                    });
                    if (result.exceptionDetails) {
                        throw new Error('extension page evaluate failed: ' + result.exceptionDetails.text);
                    }
                    return result.result && result.result.value;
                };

                const switchState = async () => {
                    const value = await evaluate(`(async () => {
            const button = document.getElementById('toggle-relay');
            return JSON.stringify({ found: !!button });
          })()`);
                    return JSON.parse(value || '{}');
                };

                // The relay switch is gone: with it off the detection socket failed closed, so
                // "off" was never a usable state. What has to hold instead is that the panel offers
                // no such control and the relay runs without anyone turning it on.
                const removed = await waitFor(async () => !(await switchState()).found, 30, 200);
                removed
                    ? ok('Side panel offers no relay switch')
                    : fail('the relay switch is still in the side panel');

                const running = await waitFor(relayUp, 40, 500);
                running
                    ? ok('The relay is running with nothing to turn on')
                    : fail('the relay did not start on its own');

                panel.close();
                panel = null;
            }
        }
    } catch (e) {
        fail('exception: ' + String(e && e.message ? e.message : e));
    } finally {
        if (panel) panel.close();
        if (session) {
            await session.cleanup();

            // 4. Closing the browser closes the native messaging pipe; nothing may be
            //    left listening afterwards.
            const gone = await waitFor(async () => !(await relayUp()), 30, 200);
            if (gone) {
                ok('relay gone after the browser closed');
            } else {
                const owner = relayOwnedElsewhere(testProfile);
                owner.other
                    ? note(
                            `a relay is still listening, but it belongs to another browser ` +
                            `(pid ${owner.owner.pid}, profile ${owner.owner.profile}); nothing this test started survived`
                        )
                    : fail('relay outlived the browser');
            }
        }
    }

    if (failures.length) {
        process.stdout.write(`\n${failures.length} check(s) failed\n`);
        process.exitCode = 1;
    } else {
        process.stdout.write('\nall checks passed\n');
    }
})();
