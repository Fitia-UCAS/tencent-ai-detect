# 朱雀检测无限使用插件

浏览器扩展（Manifest V3），用于 <https://matrix.tencent.com/ai-detect/>。

## 已知限制

**同时打开多个检测页面不是受支持的场景。**

三条身份规则是全局动态规则（`IDENTITY_RULE_ID + 0..2`），没有 `tabIds` 条件，同一时刻只描述一个地址：

- 两个检测页会互相覆盖对方写入的 `x-forwarded-for`，后写入的那个赢，先写入的页面的票据随即与自己的 socket 不一致，服务端回 `Invalid request`。
- 页面级的计数（每地址使用次数、轮换状态）也假定只有一个检测页在推进。

要支持多标签页需要单独设计隔离机制（`updateSessionRules` 配合 `tabIds`，并跟踪标签页生命周期清理），不属于当前修复范围。需要多地址时请串行使用：一个页面用完再开下一个。

## 排查

```bash
npm test                                    # 全部单元测试
node tools/diagnostics/diag-sdk-reconnect.cjs  # 站点 socket 关闭后是否会自己重连
node tools/diagnostics/diag-request-types.cjs  # 每个请求实际带的 x-forwarded-for
```
