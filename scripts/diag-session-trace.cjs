// Traces the real WebSocket lifecycle of the detection page.
//
// The open question is whether the captcha-verified conversation and the detection
// text end up on the same connection. Answering it needs facts, not inference:
// which sockets the page created, when each opened, what each sent and received,
// and when each closed. That is what this records — frame types and statuses only,
// never the fingerprint, ticket, token or detected text.
//
// This is the browser-side half; run it together with RELAY_DEBUG=1 to see the
// relay's upstream connections at the same time. Together they show whether the
// page stayed on one socket while the relay silently moved upstream.
//
// Usage:
//   node scripts/diag-session-trace.cjs [seconds] [--submit]
//
// With --submit it fills the editor and presses the button, so the flow can be
// driven without manual steps. The captcha still has to be solved by a human.
const path = require('node:path');
const fs = require('node:fs');
const { classifyPayload, analyzeVerifiedFlow } = require('./session-trace-analysis.cjs');

const BROWSER = process.env.CHROME_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9388;
const EXT = path.join(__dirname, '..');
const SITE = 'https://matrix.tencent.com/ai-detect/';
const HOLD_SECONDS = Number(process.argv[2]) || 120;
const SUBMIT = process.argv.includes('--submit');

const { sleep, httpJson, cdp, launch } = require('./browser-harness.cjs');

const SAMPLE =
    '人工智能技术的发展历程可以追溯到二十世纪五十年代，当时的科学家们开始探索用机器模拟人类智能的可能性。' +
    '在经历了多次高潮与低谷之后，随着计算能力的提升和大规模数据的积累，深度学习在二十一世纪初取得了突破性进展。' +
    '如今人工智能已经广泛应用于自然语言处理、计算机视觉、语音识别、推荐系统等诸多领域，深刻改变了人们的生产生活方式。' +
    '与此同时关于人工智能安全性、可解释性、隐私保护以及伦理规范的讨论也日益深入，成为学术界和产业界共同关注的核心议题。';

// Frame classification records only message types and safe response metadata.


async function waitForVueDetectionComponent(page, timeoutMs = 30000) {
    const expression = `(() => {
        const root = document.querySelector('#app');
        const vm = root && (root.__vue__ || root.__vue_);
        let found = false;
        const walk = node => {
            if (!node || found) return;
            if (node.websock !== undefined) { found = true; return; }
            (node.$children || []).forEach(walk);
        };
        walk(vm);
        return found;
    })()`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const result = await page.send('Runtime.evaluate', {
            expression,
            returnByValue: true
        });
        if (result && result.result && result.result.value === true) return true;
        await sleep(400);
    }
    return false;
}

(async () => {
    let session = null;
    const events = [];
    const timeline = [];

    try {
        session = await launch({
            browser: BROWSER,
            port: PORT,
            prefix: 'zqtrace',
            args: [`--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`]
        });

        const target = await httpJson(PORT, '/json/new?about:blank', 'PUT');
        const page = await cdp(target.webSocketDebuggerUrl);

        await page.send('Page.enable');
        await page.send('Runtime.enable');
        await page.send('Network.enable');

        const started = Date.now();
        const at = () => `t+${((Date.now() - started) / 1000).toFixed(1)}s`;
        const recordFrame = (requestId, label, direction, payload) => {
            const classified = classifyPayload(payload);
            timeline.push({ timeMs: Date.now(), requestId, label, direction, kind: classified.kind });
            return classified.label;
        };
        const sockets = new Map();
        let counter = 0;

        // Network.* reports the browser-level socket. requestId is stable per
        // socket, so it is the connection identity used throughout.
        page.on(msg => {
            const p = msg.params;

            if (msg.method === 'Network.webSocketCreated') {
                if (!/getClassify|127\.0\.0\.1:9420/.test(p.url)) return;
                counter += 1;
                const label = `ws#${counter}`;
                sockets.set(p.requestId, label);
                const line = `${at()}  ${label} CREATED  ${/9420/.test(p.url) ? 'local-relay' : 'direct'}`;
                events.push(line);
                process.stdout.write(line + '\n');
            }

            if (msg.method === 'Network.webSocketWillSendHandshakeRequest') {
                const label = sockets.get(p.requestId);
                if (!label) return;
                const line = `${at()}  ${label} HANDSHAKE sent`;
                events.push(line);
                process.stdout.write(line + '\n');
            }

            if (msg.method === 'Network.webSocketHandshakeResponseReceived') {
                const label = sockets.get(p.requestId);
                if (!label) return;
                const line = `${at()}  ${label} HANDSHAKE ${p.response.status} ${p.response.statusText || ''}`.trimEnd();
                events.push(line);
                process.stdout.write(line + '\n');
            }

            if (msg.method === 'Network.webSocketFrameSent') {
                const label = sockets.get(p.requestId);
                if (!label) return;
                const frameLabel = recordFrame(p.requestId, label, 'send', p.response.payloadData);
                const line = `${at()}  ${label} SEND  ${frameLabel}`;
                events.push(line);
                process.stdout.write(line + '\n');
            }

            if (msg.method === 'Network.webSocketFrameReceived') {
                const label = sockets.get(p.requestId);
                if (!label) return;
                const frameLabel = recordFrame(p.requestId, label, 'recv', p.response.payloadData);
                const line = `${at()}  ${label} RECV  ${frameLabel}`;
                events.push(line);
                process.stdout.write(line + '\n');
            }

            if (msg.method === 'Network.webSocketClosed') {
                const label = sockets.get(p.requestId);
                if (!label) return;
                const line = `${at()}  ${label} CLOSED`;
                events.push(line);
                process.stdout.write(line + '\n');
            }

            if (msg.method === 'Network.webSocketFrameError') {
                const label = sockets.get(p.requestId);
                if (!label) return;
                const line = `${at()}  ${label} FRAME ERROR ${p.errorMessage}`;
                events.push(line);
                process.stdout.write(line + '\n');
            }

            if (msg.method === 'Runtime.exceptionThrown') {
                const line = `${at()}  EXCEPTION ${msg.params.exceptionDetails.text}`;
                events.push(line);
                process.stdout.write(line + '\n');
            }
        });

        await page.send('Page.navigate', { url: SITE });
        if (SUBMIT) {
            const ready = await waitForVueDetectionComponent(page, 30000);
            if (!ready) throw new Error('detection component did not mount within 30 seconds');
        } else {
            await sleep(7000);
        }

        process.stdout.write(`\nwatching for ${HOLD_SECONDS}s\n`);

        if (SUBMIT) {
            // The editor mounts lazily and the page keeps its text in a Vue
            // component, so drive it through the component when reachable.
            const driven = await page.send('Runtime.evaluate', {
                expression: `(() => {
                    const root = document.querySelector('#app');
                    const vm = root && (root.__vue__ || root.__vue_);
                    if (!vm) return 'no vue root';
                    let target = null;
                    const walk = node => {
                        if (!node || target) return;
                        if (node.websock !== undefined) { target = node; return; }
                        (node.$children || []).forEach(walk);
                    };
                    walk(vm);
                    if (!target) return 'no component';
                    target.text = ${JSON.stringify(SAMPLE)};
                    if (target.$forceUpdate) target.$forceUpdate();
                    return 'text set, len=' + target.text.length;
                })()`,
                returnByValue: true
            });

            process.stdout.write(`drive: ${driven.result.value}\n`);
            await sleep(1200);

            const spot = await page.send('Runtime.evaluate', {
                expression: `(() => {
                    const b = [...document.querySelectorAll('button')].find(x => (x.innerText || '').includes('立即检测'));
                    if (!b) return null;
                    const r = b.getBoundingClientRect();
                    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
                })()`,
                returnByValue: true
            });

            if (spot.result.value) {
                const { x, y } = JSON.parse(spot.result.value);
                await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
                await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
                process.stdout.write(`clicked 立即检测 at ${x},${y}\n`);
            } else {
                process.stdout.write('detect button not found\n');
            }
        }

        await sleep(HOLD_SECONDS * 1000);

        // Verdict: did the page ever start a second socket, or lose the first?
        process.stdout.write('\n=== summary ===\n');

        const created = events.filter(e => /CREATED/.test(e)).length;
        const closed = events.filter(e => /CLOSED/.test(e)).length;
        const sends = events.filter(e => / SEND /.test(e));
        const recvs = events.filter(e => / RECV /.test(e));

        process.stdout.write(`page sockets created : ${created}\n`);
        process.stdout.write(`page sockets closed  : ${closed}\n`);
        process.stdout.write(`frames sent          : ${sends.length}\n`);
        process.stdout.write(`frames received      : ${recvs.length}\n`);

        const textSends = timeline.filter(event => event.direction === 'send' && event.kind === 'text');
        const ticketSends = timeline.filter(event => event.direction === 'send' && event.kind === 'ticket');
        const verifiedReplies = timeline.filter(event => event.direction === 'recv' && event.kind === 'captcha-success');

        process.stdout.write(`\nticket frames sent   : ${ticketSends.length}\n`);
        process.stdout.write(`verified replies     : ${verifiedReplies.length}\n`);
        process.stdout.write(`text frames sent     : ${textSends.length}\n`);

        const flow = analyzeVerifiedFlow(timeline);
        if (flow.status === 'verified-text-same-socket') {
            process.stdout.write(`\nverified flow: ticket, code=1/evil_level=0 and text all used ${flow.ticket.label} in order\n`);
        } else if (flow.status === 'no-ticket') {
            process.stdout.write('\nno ticket frame: the captcha was not completed, so the question remains open\n');
        } else if (flow.status === 'no-captcha-success') {
            process.stdout.write('\nticket was sent, but no code=1/evil_level=0 response was observed on that same socket\n');
        } else if (flow.status === 'no-text-after-success') {
            process.stdout.write('\ncaptcha success was observed, but no later text frame was sent on that socket\n');
        } else if (flow.status === 'captcha-success-on-different-socket') {
            process.stdout.write(`\nDIFFERENT sockets: ticket on ${flow.ticket.label}, successful verification on ${flow.success.label}\n`);
        } else if (flow.status === 'text-before-captcha-success') {
            process.stdout.write('\nORDER ERROR: text was sent before the successful captcha response\n');
        } else {
            process.stdout.write(`\nDIFFERENT sockets: verification on ${flow.success.label}, text on ${flow.text.label}\n`);
        }

        const out = path.join(__dirname, '..', 'tmp-diag', 'session-trace.txt');
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, events.join('\n') + '\n');
        process.stdout.write(`\nfull log: ${out}\n`);
    } catch (error) {
        process.stdout.write(`error: ${error.message}\n`);
        process.exitCode = 1;
    } finally {
        if (session) await session.cleanup();
    }
})();
