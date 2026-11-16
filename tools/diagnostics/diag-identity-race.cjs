// Does a freshly minted address ever arrive already spent?
//
// The page reloads itself in "immediate" mode the moment the allowance reads zero, which makes loads
// seconds apart the normal case for anyone using that setting. Each load mints a new address and the
// captcha ticket is issued for it, so if a load's handshake is answered with availableUses below five
// for an address this load just invented, the address the socket presented was not the one this load
// chose - and the ticket, issued for the chosen one, is exactly what the server then refuses as
// "Invalid request".
//
// This makes that comparison directly: reload the page several times in quick succession, then read
// the trail and put each load's chosen address next to the number its first handshake was answered
// with. One line per load, so a mismatch is visible rather than argued about.
const path = require('node:path');
const { sleep, httpJson, cdp, launch } = require('../browser-harness.cjs');
const { resolveBrowser } = require('../machine.cjs');

const EXT = path.resolve(__dirname, '..', '..');
const PORT = 9491;
const SITE = 'https://matrix.tencent.com/ai-detect/';
const EXT_ID = 'kdjgfockdecdbadmpbjgflmiffdiffhp';
const ROUNDS = Number(process.argv[2] || 5);
const SETTLE_MS = Number(process.argv[3] || 2600);

const BROWSER = resolveBrowser();

(async () => {
    const env = await launch({
        browser: BROWSER,
        port: PORT,
        prefix: 'zqcdp',
        args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
    });

    try {
        let page = null;
        for (let i = 0; i < 40 && !page; i += 1) {
            const targets = await httpJson(PORT, '/json/list');
            page = (targets || []).find(t => t.type === 'page');
            if (!page) await sleep(250);
        }
        if (!page) throw new Error('no page target');

        const conn = await cdp(page.webSocketDebuggerUrl);
        await conn.send('Page.enable');
        await conn.send('Runtime.enable');

        // The chosen address is read from the storage surfaces identity.js writes, not from the trail,
        // so the two sides of the comparison come from different places: the page for what it picked,
        // the trail for what the server was told.
        const readChosen = async () => {
            const result = await conn.send('Runtime.evaluate', {
                expression: `(() => {
                    const root = document.documentElement;
                    return JSON.stringify({
                        attribute: root && root.getAttribute('data-zq-xff'),
                        session: (() => { try { return sessionStorage.getItem('zqXff'); } catch (e) { return null; } })(),
                        uses: (() => { try { return sessionStorage.getItem('zqXffUses'); } catch (e) { return null; } })()
                    });
                })()`,
                returnByValue: true
            });
            try {
                return JSON.parse(result.result.value);
            } catch (e) {
                return null;
            }
        };

        process.stdout.write(`reloading ${SITE} ${ROUNDS} times, ${SETTLE_MS}ms apart\n\n`);

        for (let round = 1; round <= ROUNDS; round += 1) {
            if (round === 1) await conn.send('Page.navigate', { url: SITE });
            else await conn.send('Page.reload', { ignoreCache: false });

            await sleep(SETTLE_MS);
            const chosen = await readChosen();
            process.stdout.write(
                `  load ${round}  attribute=${(chosen && chosen.attribute) || '(none)'}` +
                `  session=${(chosen && chosen.session) || '(none)'}` +
                `  uses=${(chosen && chosen.uses) || '(none)'}\n`);
        }

        // The trail is written by the content script and read back by the local diagnostics, which
        // already knows how to reassemble it; re-implementing that here would be a second copy to rot.
        const { execFileSync } = require('node:child_process');
        await sleep(1500);
        const trail = execFileSync(process.execPath,
            [path.join(__dirname, 'read-trail.cjs')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

        const loads = [];
        let current = null;
        for (const line of trail.split('\n')) {
            if (/"identity":"/.test(line) && line.includes('load')) {
                current = {
                    at: line.slice(0, 12),
                    address: (line.match(/"identity":"([\d.]+)"/) || [])[1],
                    uses: null
                };
                loads.push(current);
                continue;
            }
            if (current && current.uses === null && line.includes('relay-frame')) {
                const uses = (line.match(/availableUses\\?":\s*(\d+)/) || [])[1];
                if (uses !== undefined) current.uses = Number(uses);
            }
        }

        process.stdout.write('\nload          address            first handshake answered with\n');
        let suspects = 0;
        for (const load of loads) {
            const bad = load.uses !== null && load.uses < 5;
            if (bad) suspects += 1;
            process.stdout.write(
                `  ${load.at}  ${String(load.address).padEnd(17)}  ` +
                `${load.uses === null ? '(no handshake recorded)' : load.uses + ' uses'}` +
                `${bad ? '   <-- a fresh address answered as if already used' : ''}\n`);
        }

        process.stdout.write('\n');
        if (suspects) {
            process.stdout.write(
                `${suspects} load(s) presented an address the server had already counted. The chosen\n` +
                'address and the socket\'s address differ on that load, which is the pair the server\n' +
                'refuses as "Invalid request".\n');
        } else {
            process.stdout.write(
                'Every load was answered with the full allowance, so the address the socket presents\n' +
                'agrees with the one the load chose. A refusal on a load like these comes from the\n' +
                'ticket side, not from the socket.\n');
        }

        conn.close();
    } finally {
        await env.cleanup();
    }
})().catch(error => {
    process.stderr.write(`probe failed: ${error.message}\n`);
    process.exitCode = 1;
});
