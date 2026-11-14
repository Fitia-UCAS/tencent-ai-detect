// Finds where the detection page actually keeps its text input.
//
// Plain queries for textarea / input / contenteditable return nothing on this page
// even though a large text box is clearly on screen. Guesses about selectors waste
// runs, so this reports the frame tree, any shadow roots, and every element that
// looks like an editor, then screenshots the result.
const path = require('node:path');
const fs = require('node:fs');

const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9387;
const SITE = 'https://matrix.tencent.com/ai-detect/';
const OUT = path.join(__dirname, '..', '..', 'tmp-diag');

const { sleep, httpJson, cdp, launch } = require('../browser-harness.cjs');

(async () => {
    let session = null;
    fs.mkdirSync(OUT, { recursive: true });

    try {
        session = await launch({ browser: BROWSER, port: PORT, prefix: 'zqinput' });
        const target = await httpJson(PORT, '/json/new?about:blank', 'PUT');
        const page = await cdp(target.webSocketDebuggerUrl);

        await page.send('Page.enable');
        await page.send('Runtime.enable');

        await page.send('Page.navigate', { url: SITE });
        await sleep(18000);

        // Frame tree: an editor living in a child frame would explain the misses.
        const tree = await page.send('Page.getFrameTree');
        const frames = [];
        const walk = node => {
            frames.push({ id: node.frame.id, url: String(node.frame.url).slice(0, 90), name: node.frame.name });
            (node.childFrames || []).forEach(walk);
        };
        walk(tree.frameTree);

        process.stdout.write('=== frames ===\n');
        frames.forEach(f => process.stdout.write(`  ${f.url || '(empty)'}\n`));

        // Deep scan including open shadow roots.
        const scan = await page.send('Runtime.evaluate', {
            expression: `(() => {
                const found = { editors: [], shadows: [], bigText: [] };

                const visit = (root, depth) => {
                    if (!root || depth > 6) return;
                    let all;
                    try { all = root.querySelectorAll('*'); } catch (e) { return; }

                    for (const n of all) {
                        const tag = n.tagName.toLowerCase();
                        const cls = String(n.getAttribute('class') || '');

                        if (tag === 'textarea' || tag === 'input' || n.isContentEditable ||
                            /editor|textarea|input|ql-|CodeMirror|monaco/i.test(cls)) {
                            const r = n.getBoundingClientRect();
                            found.editors.push({
                                tag, cls: cls.slice(0, 70),
                                w: Math.round(r.width), h: Math.round(r.height),
                                ce: n.getAttribute('contenteditable'),
                                id: n.id || ''
                            });
                        }

                        if (n.shadowRoot) {
                            found.shadows.push(tag + '.' + cls.slice(0, 40));
                            visit(n.shadowRoot, depth + 1);
                        }
                    }
                };

                visit(document, 0);

                // Anything with a large block of CJK text is likely the box.
                for (const n of document.querySelectorAll('div, section, article')) {
                    const t = (n.innerText || '').trim();
                    if (t.length > 200 && t.length < 4000) {
                        const r = n.getBoundingClientRect();
                        if (r.width > 300 && r.height > 100) {
                            found.bigText.push({
                                cls: String(n.getAttribute('class') || '').slice(0, 60),
                                len: t.length,
                                w: Math.round(r.width), h: Math.round(r.height),
                                editable: n.isContentEditable
                            });
                        }
                    }
                }

                found.bigText = found.bigText.slice(0, 8);
                return JSON.stringify(found, null, 1);
            })()`,
            returnByValue: true
        });

        process.stdout.write('\n=== scan ===\n' + scan.result.value + '\n');

        const png = await page.send('Page.captureScreenshot', { format: 'png' });
        const file = path.join(OUT, 'input-scan.png');
        fs.writeFileSync(file, Buffer.from(png.data, 'base64'));
        process.stdout.write(`\nscreenshot: ${file}\n`);
    } catch (error) {
        process.stdout.write(`error: ${error.message}\n`);
        process.exitCode = 1;
    } finally {
        if (session) await session.cleanup();
    }
})();
