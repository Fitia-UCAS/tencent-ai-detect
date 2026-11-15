# Zhuque Detect Unlimited Plugin

A browser extension (Manifest V3) for <https://matrix.tencent.com/ai-detect/>.

[简体中文](README.zh-CN.md)

## Install

Node.js is required for the local relay process, along with Edge.

1. Open `edge://extensions` and turn on Developer mode.
2. Choose "Load unpacked" and select this directory.
3. Run `npm run host:register` in the project directory. This registers the native messaging host the relay needs.
4. Back on `edge://extensions`, reload the extension.

Step 3 normally runs once; after moving the directory it has to run again.

## Licence

[GPL-3.0](LICENSE) © 2026 Fitia
