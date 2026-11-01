# Tencent AI Detect

Browser extension (Manifest V3) for the Tencent AI Detect page at
<https://matrix.tencent.com/ai-detect/>.

## Layout

| Path | Purpose |
| --- | --- |
| `manifest.json` | Extension manifest |
| `background.js` | Service worker: storage defaults, usage counters, context menu |
| `content.js` | Injected on the detection page: quota detection and fingerprint rotation |
| `sidepanel.html` / `sidepanel.js` | Side panel UI |
| `scripts/probe-ws.mjs` | CLI probe against the site's classification WebSocket |

## Scripts

```bash
npm run probe -- --help
```

Exit codes: `0` all probes succeeded, `1` at least one failure or timeout,
`2` bad arguments.

## Notes

Chinese literals inside `content.js` are the site's own button and quota text.
They are used for DOM matching and must not be translated.
