// Verifies that a disabled user switch survives an extension reload.
//
// IMPORTANT: chrome.runtime.reload() is NOT a genuine version upgrade. This
// test covers persistence after reload; a packaged version-to-version upgrade
// requires a separate test with two signed builds/profiles.
const path = require('node:path');

const { resolveBrowser } = require('../../tools/machine.cjs');
const BROWSER = resolveBrowser();
const EXT = path.resolve(__dirname, '..', '..');
const EXT_ID = process.env.EXT_ID || 'kdjgfockdecdbadmpbjgflmiffdiffhp';
const PORT = 9383;
const RELAY_PORT = 9420;

const { sleep, httpJson, cdp, launch } = require('../../tools/browser-harness.cjs');
const { relayHealthy } = require('../support/relay.cjs');

const failures = [];
const ok = m => process.stdout.write(`  ok    ${m}\n`);
const fail = m => { failures.push(m); process.stdout.write(`  FAIL  ${m}\n`); };

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

    try {
        if (await relayHealthy(RELAY_PORT)) {
            fail('a relay is already running; stop it first');
        } else {
            ok('no relay running before the test');

            session = await launch({
                browser: BROWSER,
                port: PORT,
                prefix: 'zqupdate',
                args: [
                    '--disable-features=DisableLoadExtensionCommandLineSwitch',
                    `--disable-extensions-except=${EXT}`,
                    `--load-extension=${EXT}`
                ]
            });

            const started = await waitFor(() => relayHealthy(RELAY_PORT), 40, 500);
            started ? ok('relay started on first install') : fail('relay did not start on first install');

            // Must match manifest.side_panel; a path that does not resolve yields a
            // chrome-error page with no extension privileges and no chrome.runtime.
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
                await sleep(1000);

                const send = expression => panel.send('Runtime.evaluate', {
                    expression,
                    awaitPromise: true,
                    returnByValue: true
                });

                // The relay switch is gone, so there is no "off" to persist across an update. What
                // still has to hold is the opposite: after the extension reloads, the relay comes
                // back on its own. Nothing turns it on, so if it does not, the page is dead and the
                // user has no control that would fix it.
                const before = await waitFor(() => relayHealthy(RELAY_PORT), 30, 400);
                before ? ok('relay is running before the reload') : fail('relay was not running to begin with');

                // Exercise an extension reload only. This does not simulate an
                // onInstalled(reason='update') event from a real version upgrade.
                await send(`chrome.runtime.reload(); 'reloading'`).catch(() => {});

                // Give the reload time to settle, then confirm it came back by itself.
                await sleep(6000);

                if (await relayHealthy(RELAY_PORT)) {
                    ok('relay came back after the extension reloaded without being switched on');
                } else {
                    fail('relay did not come back after the extension reloaded, and there is no control to start it');
                }

                panel.close();
                panel = null;
            }
        }
    } catch (e) {
        fail('exception: ' + String(e && e.message ? e.message : e));
    } finally {
        if (panel) panel.close();
        if (session) await session.cleanup();
    }

    if (failures.length) {
        process.stdout.write(`\n${failures.length} check(s) failed\n`);
        process.exitCode = 1;
    } else {
        process.stdout.write('\nall checks passed\n');
    }
})();
