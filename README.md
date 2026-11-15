# Zhuque AI Detect Helper

English · [简体中文](README.zh-CN.md)

An Edge extension (Manifest V3) for <https://matrix.tencent.com/ai-detect/>. Zhuque counts detections per outbound address, so a new address means the next detection is allowed again. This extension swaps the address for you, without touching the text on the page or your signed-in session.

## What it does

When the detection quota for the current address is nearly spent, the extension moves the page onto a fresh address. A side panel lets you choose when that happens: immediately, after a short delay, or only when you press the detect button. The page is never reloaded while you are waiting, so a half-written draft stays where it is.

## Install

Node.js is required for the local relay process, along with Edge.

1. Open `edge://extensions` and turn on Developer mode.
2. Choose "Load unpacked" and select this directory.
3. Run `npm run host:register` in the project directory. This registers the native messaging host the relay needs.
4. Back on `edge://extensions`, reload the extension.

Step 3 runs once. If you move the project directory afterwards, run it again: the host manifest holds an absolute path.

To install from a release instead of the checkout, download the zip from the releases page, extract it, and point step 2 at the extracted folder.

## Usage

Click the toolbar icon to open the side panel. It shows the current address, the remaining detections, and the swap timing. The default waits for you to confirm, so it never interrupts what you are writing.

## Known issues

See [TODO.md](TODO.md). With a system proxy (Clash and friends) enabled, `Invalid Request` can appear: the captcha ticket is fetched over the page's own HTTPS while the detection socket leaves through the local relay, and the server refuses when the two carry different addresses.

## Licence

[GPL-3.0](LICENSE), Copyright (C) 2026 Fitia. A modified version must be distributed with its source.
