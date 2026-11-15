# Zhuque Detect Unlimited Plugin

A browser extension (Manifest V3) for <https://matrix.tencent.com/ai-detect/>.

[简体中文](README.zh-CN.md)

## Install

Node.js is required for the local relay process, along with Edge.

1. Open `edge://extensions` and turn on Developer mode.
2. Choose "Load unpacked" and select this directory.
3. Run `npm run host:register` in the project directory. This registers the native messaging host the relay needs.
4. Back on `edge://extensions`, reload the extension.

Step 3 runs once. If you move the project directory afterwards, run it again: the host manifest holds an absolute path.

To install from a release instead of the checkout, download the zip from the releases page, extract it, and point step 2 at the extracted folder.

Copyright (C) 2026 Fitia

This project is released under the GNU General Public License version 3 (GPL-3.0), which is not a
permissive licence: you may use, modify and redistribute it freely, but a modified version must be
distributed with its source, and it may not be used to build a closed-source distribution. The full
terms are in [LICENSE](LICENSE), reproduced from the official text without change.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU
General Public License as published by the Free Software Foundation, version 3.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even
the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
License for more details.
