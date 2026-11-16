// Renders the side panel with a wait of zero and with a wait that is not zero.
//
// The warning exists to be read, so it is checked where it is actually drawn: a `hidden` attribute that
// a stylesheet overrides with `display: block` would leave the sentence on screen for every setting,
// and a panel whose warning never goes away stops being a warning.
const path = require('node:path');
const fs = require('node:fs');

const { sleep, httpJson, cdp, launch } = require('../browser-harness.cjs');
const { resolveBrowser } = require('../machine.cjs');

const EXT = path.resolve(__dirname, '..', '..');
const PORT = 9493;
const OUT = path.join(EXT, 'tmp-diag');
const BROWSER = resolveBrowser();

const EXT_ID = 'kdjgfockdecdbadmpbjgflmiffdiffhp';

(async () => {
    const env = await launch({
        browser: BROWSER,
        port: PORT,
        prefix: 'zqcdp',
        args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
    });

    try {
        let worker = null;
        for (let i = 0; i < 40 && !worker; i += 1) {
            const targets = await httpJson(PORT, '/json/list');
            const sw = (targets || []).find(t => t.type === 'service_worker' && (t.url || '').includes(EXT_ID));
            if (sw) worker = await cdp(sw.webSocketDebuggerUrl);
            else await sleep(250);
        }
        if (!worker) throw new Error('no extension worker: is the extension built at ' + EXT + '?');

        const panelUrl = `chrome-extension://${EXT_ID}/src/sidepanel/index.html`;
        const opened = await worker.send('Runtime.evaluate', {
            expression: `chrome.tabs.create({ url: ${JSON.stringify(panelUrl)}, active: true }).then(t => t.id)`,
            awaitPromise: true,
            returnByValue: true
        });

        let target = null;
        for (let i = 0; i < 40 && !target; i += 1) {
            const targets = await httpJson(PORT, '/json/list');
            target = (targets || []).find(t => (t.url || '').includes('sidepanel/index.html'));
            if (!target) await sleep(250);
        }
        if (!target) throw new Error('panel tab never appeared');

        const panel = await cdp(target.webSocketDebuggerUrl);
        await panel.send('Runtime.enable');
        await sleep(600);

        const measure = () => panel.send('Runtime.evaluate', {
            expression: `(() => {
                const warning = document.getElementById('spent-delay-warning');
                const hint = document.getElementById('spent-delay-hint');
                const field = document.getElementById('spent-delay');
                const box = warning ? warning.getBoundingClientRect() : null;
                return JSON.stringify({
                    cards: [...document.querySelectorAll('.spent-card')].map(c => c.dataset.mode),
                    hidden: warning ? warning.hidden : null,
                    // What is on screen, not what the attribute says.
                    visible: !!(box && box.width > 0 && box.height > 0),
                    hint: hint ? hint.textContent : null,
                    value: field ? field.value : null,
                    step: field ? field.step : null,
                    min: field ? field.min : null
                });
            })()`,
            returnByValue: true
        }).then(r => JSON.parse(r.result.value));

        const setWait = seconds => panel.send('Runtime.evaluate', {
            expression: `(async () => {
                // Chosen the way a person chooses it: by clicking the card header. Writing storage
                // directly bypasses the renderer, so the card stays collapsed and the screenshot would
                // show a state no click can produce. A second click on the card already chosen closes
                // it again, so the click is made only when it would change something.
                const card = document.querySelector('.spent-card[data-mode="delay"]');
                if (card.dataset.selected !== 'true') card.querySelector('.spent-head').click();
                const field = document.getElementById('spent-delay');
                field.value = String(${seconds});
                field.dispatchEvent(new Event('change'));
                return card.open;
            })()`,
            awaitPromise: true,
            returnByValue: true
        }).then(() => sleep(300)).then(measure);

        const start = await measure();
        process.stdout.write('cards: ' + start.cards.join(', ') + '\n');
        process.stdout.write(`as stored: wait=${start.value} step=${start.step} min=${start.min}\n`);
        process.stdout.write(`  hint "${start.hint}" warning visible=${start.visible}\n\n`);

        const two = await setWait(2);
        process.stdout.write(`wait 2: hint "${two.hint}" warning visible=${two.visible}\n`);

        const zero = await setWait(0);
        process.stdout.write(`wait 0: hint "${zero.hint}" warning visible=${zero.visible}\n`);

        // Captured while the warning is up, since that is the state worth looking at: the field, its
        // unit and the sentence that says what a zero costs all have to fit on one card. The panel is
        // taller than its window, so the card is scrolled into view first - otherwise the shot shows the
        // three headers and calls the warning missing.
        fs.mkdirSync(OUT, { recursive: true });
        const scrolled = await panel.send('Runtime.evaluate', {
            expression: `(() => {
                const el = document.querySelector('.spent-card[data-mode="delay"]');
                el.scrollIntoView({ block: 'end', behavior: 'instant' });
                window.scrollTo(0, document.documentElement.scrollHeight);
                // overflow-x: hidden on body makes body the scroll container, so the window's own
                // scroll offset stays at zero while the content it holds sits below the fold.
                document.body.scrollTop = document.body.scrollHeight;
                document.documentElement.scrollTop = document.documentElement.scrollHeight;
                const r = document.getElementById('spent-delay-warning').getBoundingClientRect();
                const app = document.querySelector('.app').getBoundingClientRect();
                const bodyRect = document.body.getBoundingClientRect();
                const style = getComputedStyle(document.body);
                return JSON.stringify({
                    top: Math.round(r.top),
                    bottom: Math.round(r.bottom),
                    viewport: window.innerHeight,
                    scrollY: Math.round(window.scrollY),
                    bodyScroll: Math.round(document.body.scrollTop),
                    scrollHeight: document.documentElement.scrollHeight,
                    bodyScrollHeight: document.body.scrollHeight,
                    app: [Math.round(app.top), Math.round(app.height)],
                    bodyRect: [Math.round(bodyRect.top), Math.round(bodyRect.height)],
                    parts: ['.brandbar', '.hero', '.dock-wrap', '.dock'].map(sel => {
                        const el = document.querySelector(sel);
                        const r = el ? el.getBoundingClientRect() : { top: 0, height: 0 };
                        return sel + ' ' + Math.round(r.top) + '+' + Math.round(r.height);
                    }),
                    card: (() => {
                        const card = document.querySelector('.spent-card[data-mode="delay"]');
                        const r = card.getBoundingClientRect();
                        const panel = card.querySelector('.spent-body-panel').getBoundingClientRect();
                        const cs = getComputedStyle(card);
                        return {
                            top: Math.round(r.top),
                            height: Math.round(r.height),
                            scrollHeight: Math.round(card.scrollHeight),
                            open: card.open,
                            body: [Math.round(panel.top), Math.round(panel.height)],
                            display: cs.display,
                            overflow: cs.overflow,
                            maxHeight: cs.maxHeight
                        };
                    })(),
                    overflow: style.overflowY,
                    // A crop is not a missing warning: this is the one number that says which it is.
                    onScreen: r.bottom <= window.innerHeight && r.top >= 0
                });
            })()`,
            returnByValue: true
        }).then(r => JSON.parse(r.result.value));
        await sleep(300);

        process.stdout.write(`  warning at ${scrolled.top}-${scrolled.bottom} of ${scrolled.viewport}px, ` +
            `scrolled ${scrolled.scrollY}/${scrolled.scrollHeight}, app ${scrolled.app},\n` +
            `  body ${scrolled.bodyRect} overflow-y ${scrolled.overflow}, on screen: ${scrolled.onScreen}\n` +
            '  ' + scrolled.parts.join(' | ') + '\n' +
            '  card: ' + JSON.stringify(scrolled.card) + '\n');

        // Captured beyond the viewport as well: the panel is taller than its window, and a shot cropped
        // to the window shows the three headers while the sentence explaining the setting sits below
        // them - which reads as a missing warning rather than as a crop.
        const zeroPng = await panel.send('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: true
        });
        fs.writeFileSync(path.join(OUT, 'panel-wait-zero.png'), Buffer.from(zeroPng.data, 'base64'));

        const back = await setWait(0.5);
        process.stdout.write(`wait 0.5: hint "${back.hint}" warning visible=${back.visible}\n`);

        // The same card with a wait that costs nothing, so the two can be compared: the warning has to
        // go away and the field must not move, or the sentence would look like part of the layout.
        const backPng = await panel.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(OUT, 'panel-wait-half.png'), Buffer.from(backPng.data, 'base64'));
        process.stdout.write('\nscreenshot: ' + path.join(OUT, 'panel-wait-zero.png') + '\n');

        panel.close();
        worker.close();

        void opened;
    } finally {
        await env.cleanup();
    }
})().catch(error => {
    process.stderr.write(`probe failed: ${error.message}\n`);
    process.exitCode = 1;
});
