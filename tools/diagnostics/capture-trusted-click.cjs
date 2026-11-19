// Is the short ticket caused by how the press was made?
//
// Every capture so far pressed with `button.click()` from `Runtime.evaluate`. That produces an event
// with `isTrusted === false`, which is not what a person produces with a mouse. If the site treats an
// untrusted press differently - by handing back a no-challenge ticket instead of opening a challenge -
// then the 130-character tickets in those captures are an artefact of the measuring tool, not a
// behaviour of the extension.
//
// That would also explain the shape of the whole trail: the runs made by a person hold mostly 202 and
// 214-character tickets that the server accepts, while the capturer's synthetic presses get 130 and
// 170.
//
// This presses both ways in one run and compares: a synthetic click, then a real one dispatched through
// the debugger's input domain, which the page receives as trusted.
const path = require('node:path');

const { resolveBrowser } = require('../machine.cjs');
const { sleep, httpJson, cdp, launch, killProfile } = require('../browser-harness.cjs');

const BROWSER = resolveBrowser();
const PORT = 9395;
const MATRIX = 'https://matrix.tencent.com/ai-detect/';
const EXT = path.join(__dirname, '..', '..');

(async () => {
    const session = await launch({
        browser: BROWSER,
        port: PORT,
        prefix: 'zqtrust',
        args: [
            `--load-extension=${EXT}`,
            `--disable-extensions-except=${EXT}`,
            '--no-first-run',
            '--window-size=1280,900'
        ],
        url: MATRIX
    });

    let page;
    for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
            const targets = await httpJson(PORT, '/json/list');
            page = targets.find(t => t.type === 'page' && String(t.url).includes('matrix.tencent.com'));
            if (page) break;
        } catch (e) {
            // Not up yet.
        }
        await sleep(500);
    }

    if (!page) {
        console.log('no page target');
        await session.cleanup();
        return;
    }

    const client = await cdp(page.webSocketDebuggerUrl);
    await client.send('Runtime.enable');
    await sleep(7000);

    await client.send('Runtime.evaluate', {
        expression: `(() => {
            window.__zqCapture = [];
            const note = (kind, text) => window.__zqCapture.push({ kind, at: Date.now(), text: String(text).slice(0, 900) });
            window.addEventListener('zq:relay-sent', e => note('sent', e.detail));
            window.addEventListener('zq:relay-frame', e => note('frame', e.detail));
            window.addEventListener('zq:quick-pass', e => note('quick-pass', JSON.stringify(e.detail && { len: e.detail.ticketLength })));
            return 'installed';
        })()`,
        returnByValue: true
    });

    // Where the button actually is, in viewport coordinates, and whether it is pressable right now.
    // It has to be scrolled into view first: dispatching a mouse event at coordinates outside the
    // viewport hits nothing, and the first attempt silently did exactly that (button at y 812 in a
    // window whose content area is shorter).
    const geometry = await client.send('Runtime.evaluate', {
        expression: `(() => {
            const b = Array.from(document.querySelectorAll('button'))
                .find(x => (x.textContent || '').includes('立即检测'));
            if (!b) return null;
            b.scrollIntoView({ block: 'center', inline: 'center' });
            const r = b.getBoundingClientRect();
            return {
                x: r.x + r.width / 2,
                y: r.y + r.height / 2,
                w: r.width, h: r.height,
                inView: r.top >= 0 && r.bottom <= window.innerHeight,
                viewH: window.innerHeight,
                disabled: b.disabled,
                text: b.textContent.trim()
            };
        })()`,
        returnByValue: true
    });

    console.log('button geometry: ' + JSON.stringify(geometry.result.value));
    if (!geometry.result.value) {
        console.log('no button');
        client.close();
        await session.cleanup();
        return;
    }

    const mark = () => client.send('Runtime.evaluate', {
        expression: 'window.__zqCapture.length',
        returnByValue: true
    }).then(r => r.result.value);

    // --- a real press, through the input domain -------------------------------------------------
    // Only this one is run: it is what a person does. The synthetic press was dropped because
    // `element.click()` on an off-screen button reached nothing, and a comparison against a press that
    // did not happen would be worse than no comparison.
    const geo = geometry.result.value;
    const state = await client.send('Runtime.evaluate', {
        expression: `(() => {
            const b = Array.from(document.querySelectorAll('button'))
                .find(x => (x.textContent || '').includes('立即检测'));
            return b ? { disabled: b.disabled, text: b.textContent.trim() } : null;
        })()`,
        returnByValue: true
    });

    console.log('');
    console.log('button now: ' + JSON.stringify(state.result.value));

    if (state.result.value && !state.result.value.disabled) {
        let before = await mark();

        // Arm a probe first, so the run records what the page itself received rather than assuming
        // the flag carried through the debugger.
        await client.send('Runtime.evaluate', {
            expression: `(() => {
                window.__zqTrust = null;
                document.addEventListener('click', e => { if (window.__zqTrust === null) window.__zqTrust = e.isTrusted; }, { capture: true });
                return 'probe armed';
            })()`,
            returnByValue: true
        });

        await client.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved', x: geo.x, y: geo.y, button: 'none', clickCount: 0
        });
        await sleep(120);
        await client.send('Input.dispatchMouseEvent', {
            type: 'mousePressed', x: geo.x, y: geo.y, button: 'left', clickCount: 1
        });
        await sleep(70);
        await client.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: geo.x, y: geo.y, button: 'left', clickCount: 1
        });

        console.log('--- press: Input.dispatchMouseEvent (a real press) ---');

        for (let tick = 0; tick < 40; tick += 1) await sleep(500);

        const after = await mark();
        const sent = await client.send('Runtime.evaluate', {
            expression: `JSON.stringify({
                trusted: window.__zqTrust,
                frames: (window.__zqCapture || []).slice(${before}, ${after})
            })`,
            returnByValue: true
        });
        console.log(sent.result.value.slice(0, 1200));
    } else {
        console.log('button not pressable; nothing to measure');
    }

    client.close();
    await sleep(500);
    await session.cleanup();
})().catch(async error => {
    console.log('failed: ' + (error && error.message));
    process.exitCode = 1;
});
