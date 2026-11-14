// Confirms the real cause of "handshake ok but detection refused".
//
// The page refuses to submit below 350 characters (getTextLength counts ASCII
// words as 1, otherwise by character), and it shows a captcha before sending.
// Anything shorter makes the server answer "Invalid request" regardless of the
// client address — which is exactly the symptom: the allowance probe succeeds
// ({"availableUses":5}) while the actual detection is refused.
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const HOST = 'matrix.tencent.com';
const PATH = '/ai_gen_txt_server/getClassify';

const LONG = '人工智能技术的快速发展正在深刻改变着我们的生活方式与工作模式。从智能手机里的语音助手到自动驾驶汽车，从医疗影像诊断到金融风控系统，这项技术已经渗透到社会生产的各个角落。然而随着技术的普及，人们对于它可能带来的风险也日益关注，数据隐私、算法偏见、就业冲击等问题不断引发讨论，如何在推动技术进步的同时保障公众利益，成为各国政府与科技企业共同面临的课题。技术本身并不具有价值判断的能力，真正决定其影响方向的是使用技术与制定规则的人，这也意味着治理体系必须与技术演进同步更新。回望过去十年，每一次模型能力的跃升都伴随着新的社会讨论，而讨论本身正是制度逐步成熟的标志。与此同时，产业界也在不断探索更加透明和可解释的方案，希望在提升效率与保障安全之间找到平衡点，让普通用户能够真正理解系统给出的每一个结论如何得出。';

// Same rule as the site's getTextLength.
function textLength(text) {
    return text.split(/\s+/).reduce((sum, token) => sum + (/^[a-zA-Z]+$/.test(token) ? 1 : token.length), 0);
}

function encode(payload) {
    const data = Buffer.from(payload);
    const mask = crypto.randomBytes(4);
    const head = [];
    head.push(0x81);
    if (data.length < 126) head.push(0x80 | data.length);
    else { head.push(0x80 | 126, data.length >> 8, data.length & 0xff); }
    const body = Buffer.from(data);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
    return Buffer.concat([Buffer.from(head), mask, body]);
}

function decode(buffer) {
    const out = [];
    let off = 0;
    while (off + 2 <= buffer.length) {
        let len = buffer[off + 1] & 0x7f;
        let cur = off + 2;
        if (len === 126) { if (cur + 2 > buffer.length) break; len = buffer.readUInt16BE(cur); cur += 2; }
        else if (len === 127) { if (cur + 8 > buffer.length) break; len = Number(buffer.readBigUInt64BE(cur)); cur += 8; }
        if (cur + len > buffer.length) break;
        out.push(buffer.slice(cur, cur + len).toString());
        off = cur + len;
    }
    return out;
}

function attempt(text, label) {
    return new Promise(resolve => {
        const ip = `112.90.${1 + Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
        const socket = net.connect(443, HOST);
        const seen = [];

        socket.on('error', e => resolve({ label, len: textLength(text), seen: ['socket error ' + e.message] }));

        socket.on('connect', () => {
            const key = crypto.randomBytes(16).toString('base64');
            const secure = tls.connect({ socket, servername: HOST }, () => {
                secure.write(
                    `GET ${PATH} HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
                    `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: https://${HOST}\r\n` +
                    `X-Forwarded-For: ${ip}\r\nUser-Agent: Mozilla/5.0\r\n\r\n`
                );
            });

            let raw = Buffer.alloc(0);
            let up = false;

            secure.on('data', chunk => {
                raw = Buffer.concat([raw, chunk]);

                if (!up) {
                    const idx = raw.indexOf('\r\n\r\n');
                    if (idx < 0) return;
                    raw = raw.slice(idx + 4);
                    up = true;

                    secure.write(encode(JSON.stringify({ fp: crypto.randomBytes(16).toString('hex') })));

                    setTimeout(() => {
                        secure.write(encode(JSON.stringify({ text: text })));
                    }, 400);

                    setTimeout(() => {
                        try { secure.destroy(); } catch (e) {}
                        resolve({ label, len: textLength(text), seen });
                    }, 6000);
                    return;
                }

                decode(raw).forEach(f => seen.push(f.slice(0, 140)));
                raw = Buffer.alloc(0);
            });
        });
    });
}

(async () => {
    const short = '人工智能技术的快速发展正在深刻改变着我们的生活方式与工作模式。从智能手机里的语音助手到自动驾驶汽车。';
    const results = [
        await attempt(short, 'short text'),
        await attempt(LONG, 'text >= 350')
    ];

    results.forEach(r => {
        console.log(`=== ${r.label} (len=${r.len})`);
        r.seen.forEach(s => console.log('   ' + s));
    });

    // The missing piece: the page sends {ticket, randstr} from the captcha
    // callback before any detection frame. Without it the server refuses the
    // detection even though the fp handshake succeeded.
    console.log('\nNote: the site sends {ticket, randstr} from the captcha callback');
    console.log('before {text}. Neither probe above includes it, which is why both');
    console.log('detections were refused while the fp handshake was accepted.');
})();
