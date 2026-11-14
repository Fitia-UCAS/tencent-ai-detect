// Reproduces the page-visible "InvalidStateError: The WebSocket is still in the
// CONNECTING state" and records what actually happened.
//
// shim.js reimplements WebSocket.send(), which must throw while CONNECTING to
// match the native contract. The page, however, reports it as an uncaught error,
// so something calls send() at a moment the wrapper is still connecting. This
// logs every send() with its readyState and caller stack, plus any uncaught
// exception, so the cause is observed rather than guessed.
const path = require('node:path');
const fs = require('node:fs');

const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9391;
const EXT = path.join(__dirname, '..', '..');
const SITE = 'https://matrix.tencent.com/ai-detect/';
const OUT = path.join(__dirname, '..', '..', 'tmp-diag');

const { sleep, httpJson, cdp, launch } = require('../browser-harness.cjs');

(async () => {
    let session = null;
    fs.mkdirSync(OUT, { recursive: true });

    try {
        session = await launch({
            browser: BROWSER,
            port: PORT,
            prefix: 'zqerr',
            args: [`--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`]
        });

        const target = await httpJson(PORT, '/json/new?about:blank', 'PUT');
        const page = await cdp(target.webSocketDebuggerUrl);

        await page.send('Page.enable');
        await page.send('Runtime.enable');

        const events = [];

        page.on(msg => {
            if (msg.method === 'Runtime.exceptionThrown') {
                const d = msg.params.exceptionDetails;
                const frames = ((d.stackTrace && d.stackTrace.callFrames) || [])
                    .slice(0, 6)
                    .map(f => `${f.functionName || '(anon)'}@${String(f.url).split('/').pop()}:${f.lineNumber + 1}`)
                    .join(' <- ');
                events.push({ kind: 'exception', text: d.text, url: d.url, line: d.lineNumber });
                process.stdout.write(`EXCEPTION ${d.text} @${d.url}:${d.lineNumber}\n    ${frames}\n`);
            }
            if (msg.method === 'Runtime.consoleAPICalled') {
                const text = msg.params.args.map(a => a.value ?? a.description ?? '').join(' ');
                if (text) process.stdout.write(`console: ${String(text).slice(0, 160)}\n`);
            }
        });

        // Wrap send() to record the readyState at each call. Wait for the shim's
        // own marker: hooking before it installs would capture the native
        // prototype instead of the wrapper's.
        await page.send('Page.addScriptToEvaluateOnNewDocument', {
            source: `
                window.__sendLog = [];
                window.__sockLog = [];
                const hook = setInterval(() => {
                    if (!window.__zqRelayShim) return;
                    const W = window.WebSocket;
                    if (!W || !W.prototype || W.prototype.__hooked) return;
                    W.prototype.__hooked = true;
                    clearInterval(hook);
                    const orig = W.prototype.send;
                    W.prototype.send = function (d) {
                        try {
                            window.__sendLog.push({
                                rs: this.readyState,
                                sockState: this._sock ? this._sock.readyState : null,
                                fellBack: this._fellBack === true,
                                stack: (new Error()).stack.split('\\n').slice(2, 6).join(' | ')
                            });
                        } catch (e) {}
                        return orig.call(this, d);
                    };
                }, 1);
            `
        });

        await page.send('Page.navigate', { url: SITE });
        await sleep(9000);

        // Drive a real detection attempt: the page keeps its text in a Vue
        // component, so setting it there is equivalent to a user pasting it.
        const SAMPLE =
            '人工智能技术的发展历程可以追溯到二十世纪五十年代，当时的科学家们开始探索用机器模拟人类智能的可能性。' +
            '在经历了多次高潮与低谷之后，随着计算能力的提升和大规模数据的积累，深度学习在二十一世纪初取得了突破性进展。' +
            '如今人工智能已经广泛应用于自然语言处理、计算机视觉、语音识别、推荐系统等诸多领域，深刻改变了人们的生产生活方式。' +
            '与此同时关于人工智能安全性、可解释性、隐私保护以及伦理规范的讨论也日益深入，成为学术界和产业界共同关注的核心议题。' +
            '未来的发展方向可能包括更强的通用推理能力、更高效的模型架构、以及更加完善的对齐机制。';

        const found = await page.send('Runtime.evaluate', {
            expression: `(() => {
                const root = document.querySelector('#app');
                const vm = root && (root.__vue__ || root.__vue_);
                if (!vm) return 'no vue root';
                let target = null;
                const walk = node => {
                    if (!node || target) return;
                    if (node.websock !== undefined && typeof node.text === 'string') { target = node; return; }
                    (node.$children || []).forEach(walk);
                };
                walk(vm);
                if (!target) return 'no component with websock+text';
                target.text = ${JSON.stringify(SAMPLE)};
                if (target.$forceUpdate) target.$forceUpdate();
                if (target.$nextTick) target.$nextTick(() => {});
                return 'set text, len=' + target.text.length + ', wsState=' +
                    (target.websock ? target.websock.readyState : 'none');
            })()`,
            returnByValue: true
        });

        process.stdout.write(`drive: ${found.result.value}\n`);
        await sleep(1500);

        // Click the real submit button with a trusted event.
        const pos = await page.send('Runtime.evaluate', {
            expression: `(() => {
                const b = [...document.querySelectorAll('button')].find(x => (x.innerText || '').includes('立即检测'));
                if (!b) return null;
                const r = b.getBoundingClientRect();
                return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
            })()`,
            returnByValue: true
        });

        if (pos.result.value) {
            const { x, y } = JSON.parse(pos.result.value);
            await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
            await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
            process.stdout.write(`clicked detect at ${x},${y}\n`);
        } else {
            process.stdout.write('submit button not found\n');
        }

        await sleep(9000);

        const log = await page.send('Runtime.evaluate', {
            expression: 'JSON.stringify(window.__sendLog || [])',
            returnByValue: true
        });

        process.stdout.write('\n=== send() calls ===\n');
        for (const entry of JSON.parse(log.result.value || '[]')) {
            process.stdout.write(
                `rs=${entry.rs} sockState=${entry.sockState} open=${entry.connected}\n    ${entry.stack}\n`
            );
        }

        const shot = path.join(OUT, 'error-state.png');
        const png = await page.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(shot, Buffer.from(png.data, 'base64'));
        process.stdout.write(`\nscreenshot: ${shot}\n`);
        process.stdout.write(`exceptions: ${events.filter(e => e.kind === 'exception').length}\n`);
    } catch (error) {
        process.stdout.write(`error: ${error.message}\n`);
        process.exitCode = 1;
    } finally {
        if (session) await session.cleanup();
    }
})();
