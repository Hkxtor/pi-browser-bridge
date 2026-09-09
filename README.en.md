# Pi Browser Bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/Hkxtor/pi-browser-bridge?include_prereleases)](https://github.com/Hkxtor/pi-browser-bridge/releases)
[![Chrome MV3](https://img.shields.io/badge/manifest-V3-blue.svg)](manifest.json)

**中文文档 → [README.md](README.md)**

> Give the [Pi](https://github.com/earendil-works/pi-coding-agent) coding agent eyes and hands inside your running Chrome browser — via one MV3 Chrome extension and a local WebSocket relay (default port **16789**), Pi can read pages, list tabs, take accessibility-tree snapshots, click elements, and fill forms.

This repository contains two parts that work together:

| Part | Location | Purpose |
|---|---|---|
| **Chrome MV3 extension** | Repository root | Connects to the local relay, executes browser operations, Popup status panel |
| **Pi extension** | `.pi/extensions/pi-browser-agent/` | Registers the `browser_*` tool family — the agent-side entry point |

---

## How It Works

```
Pi session (browser_* tools)
    │  WebSocket JSON-RPC (V2 protocol)
    ▼
ws://127.0.0.1:16789/extension/v2      ← local relay (listened by the Pi side)
    ▲
Chrome extension Service Worker (background.js)
    ├─ chrome.debugger (CDP) channel: console/network capture, navigation, file upload
    ├─ chrome.scripting channel: in-page script execution (auto-fallback to CDP)
    └─ Three content scripts:
         accessibility-tree.js → DOM → role tree + ref_N element handles
         page-bridge.js        → main-content extraction
         visual-indicator.js   → green highlight + status badge while operating (Shadow DOM isolated)
```

- The relay **listens on loopback only** (`127.0.0.1`) and is never exposed to the LAN.
- The extension auto-probes `16789` (preferred) and `16799` (backward compatibility with older Pi builds).

## Quick Start

### 1. Load the Chrome extension

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** and select this repository's root directory
4. The Pi icon appears in the toolbar (pin it for quick access)

### 2. Enable the Pi-side extension

Pi auto-discovers `.pi/extensions/pi-browser-agent/` inside this repo. To use it from another project, load it explicitly:

```bash
pi -e ./.pi/extensions/pi-browser-agent/index.ts
```

Pi then starts listening on `127.0.0.1:16789` **asynchronously** — it never blocks startup.

### 3. Verify connectivity

Just ask inside a Pi session:

```
Is the browser bridge connected?
```

or let the agent call `browser_connection_status` itself:

- ✅ `connected` — the pipeline is ready
- ❌ `port_unavailable` / timeout — see [Troubleshooting](#troubleshooting)

### 4. Everyday usage

Talk to Pi in natural language, e.g.:

> - "List all my open tabs" → `browser_tabs_list`
> - "Read the main text of the current page" → `browser_page_text`
> - "Take an accessibility-tree snapshot of this page" → `browser_page_snapshot`
> - "Click the button labeled ref_7 in the snapshot" → `browser_element_click`
> - "Fill 'hello world' into the search box (ref_3) and submit" → `browser_element_fill`

Write operations (click / fill) require authorization by default — see the permission model below.

## Tool Reference

| Tool | Type | Description |
|---|---|---|
| `browser_connection_status` | read-only | Reports connection state without making a network connection |
| `browser_discover_tools` | read-only | Discovers peer capabilities through the transport |
| `browser_tabs_list` | read-only | Tab list with the active tab marked |
| `browser_page_text` | read-only | Title / URL / main text (truncated by `maxChars`, default 50,000) |
| `browser_page_snapshot` | read-only | Accessibility-tree snapshot returning `snapshotId` + `ref_N` element refs |
| `browser_screenshot` | read-only | Currently a capability declaration only: returns a warning when unavailable; not a failure |
| `browser_element_click` | write | Clicks by `ref`; requires a grant or UI confirmation |
| `browser_element_fill` | write | Fills text by `ref`; sensitive targets force confirmation; values never logged in plain text |
| `browser_element_scroll` | write | Scrolls the element into view |

> ⚠️ **Snapshot staleness**: `ref_N` is valid only against the `snapshotId` that produced it. After a page refresh or DOM rebuild, old refs expire and tools return `stale_element_ref` (not auto-retryable) — take a fresh `browser_page_snapshot` and retry with the new refs.

## Configuration (Environment Variables)

| Variable | Default | Description |
|---|---|---|
| `PI_BROWSER_TRANSPORT` | `local-relay` | `local-relay` starts the listener; `unconfigured` falls back to the offline skeleton |
| `PI_BROWSER_RELAY_PORT` | `16789` | Relay port (the old default 16799 frequently collided with other local relay clients, hence the change) |
| `PI_BROWSER_RELAY_HOST` | `127.0.0.1` | Loopback only (`127.0.0.1` / `localhost` / `::1`); any other value is rejected |

## Permission & Security Model

- **Writes need authorization**: a session grant (sessionGranted) or a site grant (target host in grantedHosts); interactive sessions get a UI confirmation prompt.
- **Sensitive fields force confirmation**: targets whose names contain `password` / `token` / `secret` / `api key` / `authorization` / `cookie` / `credential` always require explicit confirmation, and are refused outright in headless contexts.
- **Rejection means zero side effects**: anything denied by the policy layer never touches the browser, and both denials and successes are recorded in the **in-session audit ring** (default cap 200 entries, discarded when the session ends).
- **URL blocklist**: `chrome://`, `chrome-extension://`, `about:`, `devtools:`, `view-source:`, and `javascript:` pages cannot be attached.
- **Deliberately unregistered capabilities**: high-privilege powers (R20) such as arbitrary JS execution and Cookie/network reads are not exposed; enabling them requires an explicit design review.

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| `port_unavailable` | Port in use. Find the owner: `lsof -i :16789` (macOS/Linux) or `Get-NetTCPConnection -LocalPort 16789` (Windows); or pick another port via `PI_BROWSER_RELAY_PORT` |
| `controller_transport_unconfigured` | `PI_BROWSER_TRANSPORT=unconfigured` is in effect or misspelled — check your env vars |
| `stale_element_ref` | Snapshot expired — retake `browser_page_snapshot` and retry |
| `tab_not_found` | The target `tabId` was closed — run `browser_tabs_list` and pick a live tab |
| Never connects | Make sure the extension is loaded and enabled at `chrome://extensions`; click the toolbar icon to open the Popup, check relay status, and reconnect manually |

Full troubleshooting guide: [.pi/docs/pi-browser-agent/troubleshooting.md](.pi/docs/pi-browser-agent/troubleshooting.md)

## Development & Testing

The repo is **build-free**: the root-level JS (`background.js`, `popup.js`, `content-scripts/*.js`) is the loadable output directly, while the readable TypeScript sources and tests live in `.pi/extensions/pi-browser-agent/`.

```bash
# Run the unit tests (.pi is a hidden directory, so bun test needs explicit paths)
bun test ./.pi/extensions/pi-browser-agent/protocol.test.ts \
         ./.pi/extensions/pi-browser-agent/tools.test.ts \
         ./.pi/extensions/pi-browser-agent/legacy-envelope.test.ts \
         ./.pi/extensions/pi-browser-agent/integration.test.ts
```

More docs for developers:

- Architecture walkthrough & onboarding: [.pi/docs/pi-browser-agent/onboarding.md](.pi/docs/pi-browser-agent/onboarding.md)
- Capability boundaries & error codes: [.pi/docs/pi-browser-agent/README.md](.pi/docs/pi-browser-agent/README.md)
- Live-testing runbook: [.pi/docs/pi-browser-agent/m3-live-test-runbook.md](.pi/docs/pi-browser-agent/m3-live-test-runbook.md)

## Directory Layout

```
chrome-extension/
├── manifest.json                  # MV3 manifest (extension v1.5.8)
├── background.js                  # Service Worker: relay connection / tool dispatch / CDP+scripting channels
├── popup.html / popup.js          # Toolbar popup: connection status + manual connect/disconnect
├── content-scripts/
│   ├── accessibility-tree.js      # DOM → role tree + ref_N handles
│   ├── page-bridge.js             # main-content extraction
│   └── visual-indicator.js        # operation highlight / status badge
├── _locales/{en,zh_CN}/           # Extension UI strings (en + zh-CN)
├── icons/                         # Extension icons
└── .pi/
    ├── extensions/pi-browser-agent/   # Pi-side TypeScript sources + tests + live-test scripts
    └── docs/pi-browser-agent/         # Ops & development docs
```

## License

[MIT](LICENSE)
