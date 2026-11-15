# 朱雀检测无限使用插件

朱雀检测无限使用插件，用于 <https://matrix.tencent.com/ai-detect/>。

[English](README.md)

## 安装

需要 Node.js（用于本机中转进程）和 Edge。

1. 打开 `edge://extensions`，开启「开发人员模式」。
2. 点「加载解压缩的扩展」，选择本项目目录。
3. 在项目目录执行 `npm run host:register`，注册本机中转所需的原生消息宿主。
4. 回到 `edge://extensions`，重新加载扩展。

第 3 步只做一次；之后移动了项目目录，需要重新执行一次——宿主清单里写的是绝对路径。

若想直接从发布包安装而不克隆仓库，从 Releases 页下载 zip，解压后把第 2 步指向解压出来的目录即可。

## 许可

[GPL-3.0](LICENSE) © 2026 Fitia
