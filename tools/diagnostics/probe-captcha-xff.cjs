// Does the captcha service reject a request that claims an address it did not see?
//
// The extension injects `X-Forwarded-For` on the captcha domains so the ticket is signed for the same
// address the detection socket carries. That is deliberate and it is what makes the detection accepted.
// The cost is not measured anywhere: the captcha service also sees that header, and it can compare it
// against the address the connection actually came from.
//
// If it does compare, the challenge itself fails - which is exactly what the trail shows on the failing
// load: the widget appeared at 13:47:35.916 and the page reported `captcha` at 13:47:41.352 without the
// user touching it, 5.4 seconds later, on a screen that said "已更换题目".
//
// This asks the captcha service directly, twice, with the same request: once claiming an address the
// connection does not come from, once claiming nothing. Nothing about the site or the extension is
// involved; the response is the service's own verdict.
const https = require('node:https');

const HOST = 't.captcha.qq.com';

// The service needs the parameters its own page sends. These are the ones observed on the live page;
// the values that matter here are `aid` (the site's app id) and `accver`.
function prehandle(claimedAddress) {
    const query = new URLSearchParams({
        aid: '2089775896',
        protocol: 'https',
        accver: '1',
        showtype: 'popup',
        ua: 'TW96aWxsYS81LjAgKFdpbmRvd3MgTlQgMTAuMDsgV2luNjQ7IHg2NCkgQXBwbGVXZWJLaXQvNTM3LjM2',
        noheader: '0',
        fb: '1',
        aged: '0',
        enableAged: '0',
        enableDarkMode: '0',
        grayscale: '1',
        dyeid: '0',
        clientype: '2',
        cap_cd: '',
        uid: '',
        lang: 'zh-cn',
        entry_url: 'https://matrix.tencent.com/ai-detect/',
        callback: '_aq_123456',
        sess: '',
        param: ''
    });

    const path = '/cap_union_prehandle?' + query.toString();
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36',
        Referer: 'https://matrix.tencent.com/',
        Accept: '*/*'
    };

    if (claimedAddress) headers['X-Forwarded-For'] = claimedAddress;

    return new Promise(resolve => {
        const request = https.request({ host: HOST, path, method: 'GET', headers, timeout: 12000 }, response => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', chunk => (body += chunk));
            response.on('end', () => {
                const payload = body.replace(/^[^(]*\(/, '').replace(/\)\s*$/, '');
                let parsed = null;
                try {
                    parsed = JSON.parse(payload);
                } catch (e) {
                    // Left null; the raw text is reported instead.
                }

                resolve({
                    status: response.statusCode,
                    claimed: claimedAddress || '(none)',
                    state: parsed ? parsed.state : null,
                    capclass: parsed ? parsed.capclass : null,
                    ticket: parsed ? parsed.ticket : null,
                    sessLen: parsed && parsed.sess ? parsed.sess.length : 0,
                    errorCode: parsed ? parsed.errorCode : null,
                    errMsg: parsed ? parsed.errmsg || parsed.msg : null,
                    raw: !parsed ? body.slice(0, 240) : null
                });
            });
        });

        request.on('timeout', () => request.destroy(new Error('timeout')));
        request.on('error', error => resolve({ claimed: claimedAddress || '(none)', error: error.message }));
        request.end();
    });
}

(async () => {
    console.log('Asking the captcha service the same question twice.');
    console.log('The only difference is the address the request claims to come from.');
    console.log('');

    for (const claim of [null, '175.6.189.239', '112.51.129.48']) {
        const result = await prehandle(claim);
        console.log('claimed: ' + result.claimed);
        console.log('  ' + JSON.stringify({
            status: result.status,
            state: result.state,
            capclass: result.capclass,
            ticket: result.ticket,
            sessLen: result.sessLen,
            errorCode: result.errorCode,
            errMsg: result.errMsg,
            error: result.error
        }));
        console.log('');
    }
})();
