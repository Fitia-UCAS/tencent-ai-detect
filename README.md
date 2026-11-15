# 朱雀 AI 检测助手

[English](#english) · 简体中文

用于 <https://matrix.tencent.com/ai-detect/> 的 Edge 扩展（Manifest V3）。朱雀按出口地址计次，地址一换就能继续检测；这个扩展负责在你察觉不到的时候把地址换掉，页面上的文本和登录态都留在原处。

## 它做什么

检测次数快用完时自动切换到新地址，并提供一个侧栏让你决定换的时机：立即换、延迟几秒换，或者等你按下「立即检测」再换。等待期间页面不会自己刷新，草稿不会丢。

## 安装

需要 Node.js（用于本机中转进程）和 Edge。

1. 打开 `edge://extensions`，开启「开发人员模式」。
2. 点「加载解压缩的扩展」，选择本项目目录。
3. 在项目目录执行 `npm run host:register`，注册本机中转所需的原生消息宿主。
4. 回到 `edge://extensions`，重新加载扩展。

第 3 步只做一次；之后移动了项目目录，需要重新执行一次——宿主清单里写的是绝对路径。

## 使用

点工具栏图标打开侧栏。里面能看到当前地址、剩余次数、以及换地址的时机选项。默认等待你手动确认，不会打断你正在写的内容。

## 已知问题

见 [TODO.md](TODO.md)。代理（Clash 等）开启时可能出现 `Invalid Request`：取票走页面自己的 HTTPS，数据 socket 走本机中转，两个出口地址不一致会被服务端拒绝。

## 许可

[GPL-3.0](LICENSE)，Copyright (C) 2026 Fitia。分发修改后的版本必须一并提供源代码。

---

## English

An Edge extension (Manifest V3) for <https://matrix.tencent.com/ai-detect/>. Zhuque counts detections per outbound address, so a new address means the next detection is allowed again. This extension swaps the address for you, without touching the text on the page or your signed-in session.

### What it does

When the detection quota for the current address is nearly spent, the extension moves the page onto a fresh address. A side panel lets you choose when that happens: immediately, after a short delay, or only when you press the detect button. The page is never reloaded while you are waiting, so a half-written draft stays where it is.

### Install

Node.js is required for the local relay process, along with Edge.

1. Open `edge://extensions` and turn on Developer mode.
2. Choose "Load unpacked" and select this directory.
3. Run `npm run host:register` in the project directory. This registers the native messaging host the relay needs.
4. Back on `edge://extensions`, reload the extension.

Step 3 runs once. If you move the project directory afterwards, run it again: the host manifest holds an absolute path.

### Usage

Click the toolbar icon to open the side panel. It shows the current address, the remaining detections, and the swap timing. The default waits for you to confirm, so it never interrupts what you are writing.

### Known issues

See [TODO.md](TODO.md). With a system proxy (Clash and friends) enabled, `Invalid Request` can appear: the captcha ticket is fetched over the page's own HTTPS while the detection socket leaves through the local relay, and the server refuses when the two carry different addresses.

### Licence

[GPL-3.0](LICENSE), Copyright (C) 2026 Fitia. A modified version must be distributed with its source.
