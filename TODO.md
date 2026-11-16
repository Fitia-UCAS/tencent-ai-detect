# TODO

- [ ] 绕过弹窗（验证窗），或找一个能替代它的方案直接检测，不被弹窗（验证窗）打断。
- [ ] 解决 Clash 等代理开启时出现的“Invalid Request”报错问题。
- [x] 解决检测时出现的 “Exception Occured” 报错问题。
- [ ] 登录状态有 20 次机会，寻找能直接刷新其次数的方式，一次拿到 20 次。
- [ ] 寻找绕过官网、直接修改检测次数的方式，无论登录与否都能长期使用。作为最终目标：检测次数 +∞。

**备注**

- 第 1 条成因未明：验证窗由站点的风控决定，实测出现没有规律，日志里也没有可与其它事件对应的记录。
- 第 2 条已实测两件事：① 在这台机器的 Clash（rule 模式、系统代理 127.0.0.1:7897）下 socket 这半边与代理无关——同一个伪造地址，直连和经 CONNECT 隧道都是 `{"status":"success","availableUses":5}`（`npm run diag:proxy-path`）；② 代理不会改写 `X-Forwarded-For`，明文 HTTP 转发出入一致（`npm run diag:proxy-headers`）。已修的实症是 relay 的出站路径原先在启动时定死：中途开关 Clash，页面立刻跟着代理走，socket 还留在原来的路上，两条出口就此分开；现在每次拨号按当前开关重读（5 秒节流），日志里会写 `outbound changed A -> B`。仍未定的一点：被拒的是**票**不是 socket，帧是 `{"code":"21","msg":"diff"}` 紧跟 `{"status":"failed","msg":"Invalid request"}`，即服务器认为票与 socket 声明的地址不符；票由验证码服务签发，要抓签发它的那条请求必须先解一次验证码，下一步用 `npm run diag:request-types` 在出现该错误时抓。
- 第 3 条成因已查清：这句话来自服务器，是一条回复帧 `{"status":"failed","msg":"Exception Occured!","availableUses":N,"feedback_token":…}`，不是页面的 JS 异常——它跟在 `{"code":"1"}`→文本→`{"status":"waiting"}` 之后 8~15ms 到，之前没有 code 21、按下时验证码是关的，而且**不扣次数**（帧里的 availableUses 是请求前的值）。实测同一段文本（md5 相同、1127 字节）在同一连接上被成功出过 12 次报告，所以请求本身没问题，是服务端自己抛了。修法：把这条帧单独判成一类，自动重问一次（不轮换地址，因为它跟地址无关），重问次数记在尝试记录里。取证用 `tools/diagnostics/read-failures.cjs`。
- 第 4 条[朱雀AI检测次数重置工具](https://tools.yikeaigc.com/zhuque-reset-tool.php)声称可解除20次使用限制，不更换电脑即可继续进行更多次AI文案检测，但实际情况无法验证，或许可以做个完整的逆向...？？？
- 第 5 条「+∞」是使用者感觉不到上限（耗尽前换地址），不是服务端账本无限（实际上已经粗浅的实现只是界面刷新时会有点体验不佳）。
