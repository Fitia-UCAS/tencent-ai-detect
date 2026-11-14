# Findings: reverse-engineered batch tool (AI文章图片批量检测工具)

Source: D:/EdgeDownloads/AI文章图片批量检测工具/AI文章图片批量检测工具.exe
Packer: PE .rsrc holds a 26 MB blob = "KAY" + zstd frame (28 b5 2f fd); node zlib.zstdDecompressSync
unpacks it to 94 MB. The app itself is Python compiled with Nuitka (NUITKA_PACKAGE_PyQt5), so no
.pyc exists; logic was recovered from string constants and the site bundle.

## The tool implements the ANONYMOUS path only

It never sets a token. Its only token operation is:

    localStorage.removeItem("aiGenAccessToken"); localStorage.removeItem("userInfo");

and it clears the cached counters:

    aiGenTxtRemainingCount, aiGenTxtLastCheckDate, aiGenPicRemainingCount, aiGenPicLastCheckDate

plus CDP Storage.clearDataForOrigin (session_storage). So there is no logged-in quota logic in
this tool to copy - it deliberately logs the page out.

It also overrides window.WebSocket to route wss://matrix.tencent.com/* to a local bridge,
and injects X-Forwarded-For through Network.setExtraHTTPHeaders.

## Why X-Forwarded-For spoofing breaks detection

The tool keeps this note verbatim in its constants:

    Batch text works more reliably without XFF because captcha and WS match.

The captcha ticket is bound to the IP that fetched it. The tool fetches the captcha prehandle
itself (t.captcha.qq.com/cap_union_prehandle, aid 2089775896) and parses "uip" from the JSONP
reply to confirm the identity before using it. When the ticket is obtained over one IP and the
websocket carries a different XFF, the server answers Invalid request.

That is exactly the failure mode in this extension: the relay spoofs XFF on the upstream
websocket, while the page fetches its captcha over plain HTTPS with the real IP.

## The site: where 20 comes from

app.js carries the site config: useLimit: 20.

aigen.js getInitialRemainingCount():

    var today = new Date().toLocaleDateString();
    var last  = localStorage.getItem("aiGenTxtLastCheckDate");
    if (last !== today) {
        localStorage.setItem("aiGenTxtLastCheckDate", today);
        localStorage.setItem("aiGenTxtRemainingCount", useLimit);   // 20
        return useLimit;
    }
    return parseInt(localStorage.getItem("aiGenTxtRemainingCount") || useLimit, 10);

So 20 is the client-side declared daily cap, re-seeded whenever the stored date is not today.
Clearing those two keys therefore makes the button read "今日剩余20次" again.

The server is authoritative on success: availableUses overwrites the counter, and status
"limited" forces it to 0 and persists "0". An anonymous handshake answers availableUses: 5.

## Auth handshake

    websocketOnopen: var t = getAccessToken();
                    send(t ? {access_token: t} : {fp: getFp()})

The server replies with access_token + uid for anonymous visitors, and the client stores it and
resends {access_token}. So anonymous visitors are given a per-fingerprint identity.

## Unverified

Whether a logged-in account gets availableUses 20 from the server. The client constant is 20 and
anonymous is 5, which fits, but the server value for a real account has not been observed - that
needs a logged-in session.

## Measured: the synthetic address is required, not optional

Run against the real server with the relay carrying the page's own frames:

    synthetic X-Forwarded-For -> {fp} answered {"status": "success", "availableUses": 5}
    real address              -> {fp} answered {"status": "failed", "msg": "Invalid request"}

So dropping the spoof breaks the identity handshake. An earlier assumption that the spoof itself
caused Invalid request was wrong, and acting on it was a regression; test:relay-spoof-policy now
pins the default so it cannot be flipped again by assumption.

## Where the reference tool differs

It does not spoof the socket alone. It injects the same address on every page request through
CDP Network.setExtraHTTPHeaders, and separately fetches the captcha prehandle through a proxy and
reads "uip" from the JSONP reply to confirm the identity matches before using it. That is what makes
captcha and websocket agree.

This relay can only set the header on the websocket, so the page's captcha fetch still carries the
real address. Closing that gap needs one of:
  1. an upstream HTTP proxy with real rotating egress addresses (the tool supports xiequ/kuaidaili
     for exactly this), so the page's own captcha request also leaves through the rotating address;
  2. proxying the captcha request too, which on HTTPS means terminating TLS locally.
