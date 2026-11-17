// Records what mints a captcha ticket, not just what the ticket says.
//
// The detection server answers code 21 / "diff" for some tickets and accepts others, and the trail
// already shows the two shapes: accepted tickets are 202 or 214 characters and follow a visible
// challenge, refused ones are 170 characters and arrive about a second after the press with no
// challenge on screen. What the trail cannot show is the request that decided which kind to issue:
// the captcha SDK's own cap_union_prehandle call. That call, and its answer, are what this records,
// together with the X-Forwarded-For each request carried and the frames on the relay socket.
//
// The question it exists to answer: does the proxy change what the captcha service is told, or does
// it change what the captcha service decides? Routing is not the axis - measured on this machine,
// t.captcha.qq.com and matrix.tencent.com are DIRECT under the proxy's cn rule set, and the
// synthetic address still reaches the capture requests.
//
// Usage:
//   node tools/diagnostics/diag-ticket-mint.cjs             # browser direct
//   node tools/diagnostics/diag-ticket-mint.cjs --proxy     # browser points at 127.0.0.1:7897
//
// The window is visible on purpose: if a challenge appears, solving it by hand is what completes the
// exchange, and the point of the run is to compare the two outcomes.
const path = require('node:path');
const { resolveBrowser } = require('../machine.cjs');
const { sleep, httpJson, cdp, launch } = require('../browser-harness.cjs');

const BROWSER = resolveBrowser();
const EXT = process.env.ZQ_EXT_DIR
    ? path.resolve(process.env.ZQ_EXT_DIR)
    : path.join(__dirname, '..', '..');
const PORT = 9491;
// The detector is a route, not the site root: the root renders the home page, whose buttons make a
// "the app is up" readiness check pass while there is no textarea to fill.
const SITE = 'https://matrix.tencent.com/ai-detect/ai_gen_txt';
const WITH_PROXY = process.argv.includes('--proxy');
const HEADLESS = process.argv.includes('--headless');
// Manual mode leaves the press and the challenge to the person at the keyboard. The captcha type
// decides which ticket is issued, and only a real solve can produce the other type.
const MANUAL = process.argv.includes('--manual');
// Baseline: the same page with no extension at all, so the site's own socket and its own address
// are used. It separates "the ticket is refused" from "the extension's ticket is refused".
const NO_EXT = process.argv.includes('--no-ext');
// Off-screen keeps the window out of reach, so a run measures the captcha's own decision instead of
// a person finishing the challenge in it.
const OFFSCREEN = process.argv.includes('--offscreen');
// Puts the identity on the tab through CDP instead of the relay, so the WebSocket is the browser's
// own. It is the test for whether the relay's transport is what the server refuses.
const CDP_XFF = process.argv.includes('--cdp-xff');
const WATCH_MS = 45000;

const CAPTURE = /cap_union|prehandle|verify|ticket|captcha\.gtimg|t\.captcha\.qq\.com/i;
const INTERESTING_URL = /captcha|gtimg|qcloud|matrix\.tencent\.com/i;

function keyOf(sessionId, requestId) {
    return JSON.stringify([sessionId || 'root', requestId]);
}

function short(value, limit = 400) {
    const text = String(value === undefined || value === null ? '' : value);
    return text.length > limit ? `${text.slice(0, limit)}... (${text.length})` : text;
}

// The ticket shape is the discriminator the trail cannot explain, so every frame is labelled with
// what it was rather than dumped: a ticket frame is 200 characters of encrypted payload.
function frameLabel(payload) {
    const raw = String(payload || '');
    if (/"ticket"/.test(raw)) return 'TICKET';
    if (/"fp"/.test(raw)) return 'FP';
    if (/"access_token"/.test(raw)) return 'TOKEN';
    if (/"text"/.test(raw)) return 'TEXT';
    if (/"code"\s*:\s*"21"/.test(raw)) return 'CODE21';
    if (/"msg"/.test(raw)) return 'FAILED';
    if (/"status"/.test(raw)) return 'STATUS';
    return 'OTHER';
}

function frameDetail(payload) {
    const raw = String(payload || '');
    if (/"ticket"/.test(raw)) {
        try {
            const parsed = JSON.parse(raw);
            return `ticket=${String(parsed.ticket || '').length} chars randstr=${parsed.randstr}`;
        } catch (e) {
            return raw.slice(0, 80);
        }
    }
    return short(raw, 300);
}

// The captcha answers are JSONP, so the fields that matter are read out of the first object rather
// than by matching text: subcapclass names the challenge type, errorCode says whether it passed.
function capFields(body) {
    const text = String(body || '');
    const at = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (at === -1 || end <= at) return null;

    try {
        const parsed = JSON.parse(text.slice(at, end + 1));
        return {
            state: parsed.state,
            subcapclass: parsed.subcapclass,
            errorCode: parsed.errorCode,
            ticket: String(parsed.ticket || '').length
        };
    } catch (e) {
        return null;
    }
}

(async () => {
    const args = NO_EXT ? [] : [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`];
    if (WITH_PROXY) args.push('--proxy-server=http://127.0.0.1:7897');
    if (HEADLESS) args.push('--headless=new');
    if (OFFSCREEN) args.push('--window-position=-3200,-3200', '--window-size=1000,800');

    process.stdout.write(`mode: ${NO_EXT ? 'no extension' : 'extension'}, browser proxy ${WITH_PROXY ? '127.0.0.1:7897' : 'direct'}` +
        `, ${HEADLESS ? 'headless' : 'visible'}${MANUAL ? ', manual' : ', auto'}${OFFSCREEN ? ', offscreen' : ''}\n`);

    // With --cdp-xff the header has to be in place before the page opens its socket, and the value
    // cannot come from the page because the page has not loaded yet. A fixed address is enough: both
    // the captcha request and the socket then carry it.
    const session = await launch({
        browser: BROWSER, port: PORT, prefix: 'zqmint', args,
        url: CDP_XFF ? 'about:blank' : SITE
    });

    try {
        let page = null;
        for (let i = 0; i < 40 && !page; i += 1) {
            const targets = await httpJson(PORT, '/json/list');
            page = (targets || []).find(t => CDP_XFF
                ? t.type === 'page'
                : (t.url || '').includes('matrix.tencent.com'));
            if (!page) await sleep(300);
        }
        if (!page) throw new Error('page never opened');

        const conn = await cdp(page.webSocketDebuggerUrl);

        // requestKey -> { url, type, status, xff[], body }
        const requests = new Map();
        let challenge = 'not seen';
        let ticketSent = false;
        let ticketReplied = false;

        function record(sessionId, params) {
            const url = (params.request && params.request.url) || '';
            if (!INTERESTING_URL.test(url)) return;
            requests.set(keyOf(sessionId, params.requestId), {
                url, type: params.type, status: null, xff: [], body: null, sessionId
            });
        }

        function recordHeaders(sessionId, params) {
            const entry = requests.get(keyOf(sessionId, params.requestId));
            if (!entry) return;
            const name = Object.keys(params.headers || {}).find(n => n.toLowerCase() === 'x-forwarded-for');
            entry.xff.push(name ? String(params.headers[name]) : null);
        }

        async function watch(sessionId) {
            await conn.send('Network.enable', {}, sessionId);
            await conn.send('Target.setAutoAttach', {
                autoAttach: true, waitForDebuggerOnStart: false, flatten: true
            }, sessionId);
        }

        function noteFrame(payload) {
            const label = frameLabel(payload);
            process.stdout.write(`  WS ${label} ${frameDetail(payload)}\n`);
            if (label === 'TICKET') ticketSent = true;
            if (label === 'CODE21' || label === 'FAILED' || label === 'STATUS') {
                if (ticketSent) ticketReplied = true;
            }
        }

        conn.on(msg => {
            const sessionId = msg.sessionId;

            if (msg.method === 'Target.attachedToTarget') {
                watch(msg.params.sessionId).catch(() => {});
                return;
            }

            if (msg.method === 'Network.requestWillBeSent') {
                record(sessionId, msg.params);
                return;
            }

            if (msg.method === 'Network.requestWillBeSentExtraInfo') {
                recordHeaders(sessionId, msg.params);
                return;
            }

            if (msg.method === 'Network.responseReceived') {
                const entry = requests.get(keyOf(sessionId, msg.params.requestId));
                if (entry) entry.status = msg.params.response.status;
                return;
            }

            if (msg.method === 'Network.loadingFinished') {
                const key = keyOf(sessionId, msg.params.requestId);
                const entry = requests.get(key);
                if (!entry || !CAPTURE.test(entry.url)) return;
                conn.send('Network.getResponseBody', { requestId: msg.params.requestId }, sessionId)
                    .then(result => {
                        entry.body = result && result.body ? result.body : null;
                    })
                    .catch(() => {});
                return;
            }

            if (msg.method === 'Network.webSocketWillSendHandshakeRequest') {
                const headers = msg.params.request && msg.params.request.headers;
                process.stdout.write('  WS HANDSHAKE ' + JSON.stringify(headers) + '\n');
                return;
            }

            if (msg.method === 'Network.webSocketCreated') {
                process.stdout.write(`  WS OPEN ${String(msg.params.url || '').slice(0, 140)}\n`);
                return;
            }

            if (msg.method === 'Network.webSocketFrameSent') noteFrame(msg.params.response.payloadData);
            if (msg.method === 'Network.webSocketFrameReceived') noteFrame(msg.params.response.payloadData);
        });

        await watch(undefined);
        await conn.send('Page.enable');
        await conn.send('Runtime.enable');

        if (CDP_XFF) {
            await conn.send('Network.setExtraHTTPHeaders', {
                headers: { 'X-Forwarded-For': '112.80.10.10' }
            });
            await conn.send('Page.navigate', { url: SITE });
        }

        // Wait for the detector itself: the textarea only exists on the ai_gen_txt route.
        let ready = false;
        for (let i = 0; i < 40 && !ready; i += 1) {
            const probe = await conn.send('Runtime.evaluate', {
                expression: `!!(document.querySelector('.txt-input textarea') || document.querySelector('textarea'))`,
                returnByValue: true
            });
            ready = Boolean(probe.result && probe.result.value);
            if (!ready) await sleep(500);
        }
        if (!ready) throw new Error('detector textarea never appeared at ' + SITE);

        await conn.send('Runtime.evaluate', {
            expression: `(() => {
                const x = document.querySelector('.el-notification__closeBtn, .el-message-box__close');
                if (x) x.click();
            })()`
        });

        // The identity rule is applied asynchronously; pressing before it is confirmed would make
        // this run measure the extension's own guard instead of the ticket.
        await sleep(3000);

        const identity = await conn.send('Runtime.evaluate', {
            expression: `(() => {
                let stored = null;
                try { stored = sessionStorage.getItem('zqXff'); } catch (e) {}
                return JSON.stringify({
                    attribute: document.documentElement.getAttribute('data-zq-xff'),
                    session: stored
                });
            })()`,
            returnByValue: true
        });
        process.stdout.write(`page identity: ${identity.result ? identity.result.value : '?'}\n`);

        if (CDP_XFF) {
            let ip = CDP_XFF ? '112.80.10.10' : null;
            if (ip) {
                await conn.send('Network.setExtraHTTPHeaders', { headers: { 'X-Forwarded-For': ip } });
                process.stdout.write(`cdp header set: X-Forwarded-For ${ip}\n`);
            } else {
                process.stdout.write('cdp header: no identity to set\n');
            }
        }

        if (MANUAL) {
            process.stdout.write('manual: paste text in the window, press the detect button, and solve the challenge\n');
        } else {
            // Type enough text for the site to accept the press, through the native setter so Vue's
            // v-model sees the change.
            const typed = await conn.send('Runtime.evaluate', {
                expression: `(() => {
                    const ta = document.querySelector('.txt-input textarea') || document.querySelector('textarea');
                    if (!ta) return 'no textarea';
                    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
                    setter.call(ta, ('这是一段用于检测的中文文本，用来观察验证码票据的签发过程。'.repeat(12)) + Date.now());
                    ta.dispatchEvent(new Event('input', { bubbles: true }));
                    ta.dispatchEvent(new Event('change', { bubbles: true }));
                    return ta.value.length;
                })()`,
                returnByValue: true
            });
            process.stdout.write(`text typed: ${typed.result ? typed.result.value : '?'}\n`);

            const spot = await conn.send('Runtime.evaluate', {
                expression: `(() => {
                    const hits = [...document.querySelectorAll('button')]
                        .filter(b => (b.innerText || '').includes('立即检测'))
                        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
                    const b = hits[0];
                    if (!b) return null;
                    const r = b.getBoundingClientRect();
                    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
                })()`,
                returnByValue: true
            });

            if (!spot.result || !spot.result.value) throw new Error('detect button not found');

            const point = JSON.parse(spot.result.value);
            await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
            await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
            process.stdout.write('detect pressed; watching captcha and socket\n');
        }

        const deadline = Date.now() + (MANUAL ? 600000 : WATCH_MS);
        while (Date.now() < deadline) {
            await sleep(500);

            const state = await conn.send('Runtime.evaluate', {
                expression: `(() => {
                    const el = document.getElementById('tcaptcha_iframe_dy')
                        || document.getElementById('tcaptcha_iframe')
                        || document.getElementById('tcaptcha_transform')
                        || document.querySelector('.tcaptcha-transform');
                    if (!el) return 'absent';
                    const r = el.getBoundingClientRect();
                    const s = getComputedStyle(el);
                    // The placeholder lives far off-screen at y=-1000000 and is not a challenge.
                    const visible = r.width > 100 && r.height > 100 && r.y > -1000 && r.x > -1000;
                    return JSON.stringify({ visible,
                        x: Math.round(r.x), y: Math.round(r.y),
                        w: Math.round(r.width), h: Math.round(r.height),
                        display: s.display, opacity: s.opacity });
                })()`,
                returnByValue: true
            });

            const value = state.result && state.result.value;
            if (value && value !== 'absent' && value !== challenge) {
                challenge = value;
                process.stdout.write(`  challenge ${challenge}\n`);
            }

            // In manual mode the first reply may be the captcha's own quick pass, arriving before the
            // person has finished the slider. Closing on it is what made an earlier run end mid-solve.
            if (ticketSent && ticketReplied && !MANUAL) break;
        }

        process.stdout.write('\n--- captcha requests ---\n');
        for (const entry of requests.values()) {
            if (!INTERESTING_URL.test(entry.url)) continue;
            const xff = entry.xff.length ? entry.xff.map(v => v || '(none)').join(',') : '(not seen)';
            process.stdout.write(`[${entry.type}] ${entry.status || '?'} xff=${xff}\n  ${entry.url.slice(0, 140)}\n`);
            if (entry.body && CAPTURE.test(entry.url)) {
                process.stdout.write(`  body: ${short(entry.body, 600)}\n`);
                const fields = capFields(entry.body);
                if (fields) {
                    process.stdout.write(`  fields: state=${fields.state} subcapclass=${fields.subcapclass}` +
                        ` errorCode=${fields.errorCode} ticket=${fields.ticket}\n`);
                }
            }
        }

        process.stdout.write(`\n--- result ---\nchallenge: ${challenge}\nticket sent: ${ticketSent}\nreply seen: ${ticketReplied}\n`);
        if (MANUAL) process.stdout.write('manual run: close the window yourself when you are done\n');
    } finally {
        await session.cleanup();
    }
})().catch(error => {
    process.stdout.write(`error: ${(error && error.message) || error}\n`);
    process.exit(1);
});
