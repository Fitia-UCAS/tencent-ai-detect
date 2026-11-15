# 朱雀检测无限使用插件

朱雀检测无限使用插件，用于 <https://matrix.tencent.com/ai-detect/>。

[English](README.md)

## 安装

需要 Node.js（用于本机中转进程）和 Edge。

1. 打开 `edge://extensions`，开启「开发人员模式」。
2. 点「加载解压缩的扩展」，选择本项目目录。
3. 在项目目录执行 `npm run host:register`，注册本机中转所需的原生消息宿主。
4. 回到 `edge://extensions`，重新加载扩展。

一般情况下第 3 步只做一次；移动目录后需重新执行一次。

## 许可

[GPL-3.0](LICENSE) © 2026 Fitia
