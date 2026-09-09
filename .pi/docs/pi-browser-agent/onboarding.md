# Onboarding：Pi Browser Bridge（Chrome 扩展 + Pi 浏览器 Agent）

> 面向维护者/新成员的导览。覆盖仓库两个互相配套的部件：
> ① 仓库根部的 **MV3 Chrome 扩展**（`manifest.json` v1.5.8，“Pi Browser Bridge”）
> ② `.pi/extensions/pi-browser-agent/` 中的 **Pi 扩展**（注册 `browser_*` 工具，驱动前者）。
> 排查手册见 [troubleshooting.md](./troubleshooting.md)，能力边界见 [README.md](./README.md)。

## What This Is

这是一个**无构建步**的仓库：

- 根目录即为可直接加载的 Chrome MV3 扩展（解压加载 `chrome://extensions/` → 开发者模式 → “加载已解压的扩展程序”）。
- 扩展把浏览器连接到本地中继（`ws://127.0.0.1:16789/extension/v2`，回退端口 16799），让 Pi 以 MCP 风格工具自动黄冲浪。
- 所有运行时 JS（`background.js`、`popup.js`、`content-scripts/*.js`）均为**压缩/bundle 产物**，单文件单/少行长行是其常态——不要按“手写源码”的预期去格式化它们。
- `.pi/` 下的 TypeScript 才是**可读、可测试、可修改的源码层**（Pi 侧扩展 + 测试 + 文档）。

## Tech Stack

- **扩展侧**：Chrome MV3 Service Worker、原生 ES Module（`background.js` 为 module）、无 npm/无 bundler、无 Node 依赖
- **Pi 侧**：TypeScript + Bun 测试（`bun test`，需显式路径）、`@earendil-works/pi-ai` 的 `Type` 参数 schema、Pi Extension API
- **协议**：WebSocket JSON-RPC（V2，`pibrowser.browserTabHandoff.*` 方法）+ CDP（chrome.debugger，`1.3`）双通道；另有 legacy V1/native messaging 兼容层
- **i18n**：`_locales/{en,zh_CN}/messages.json`，manifest 用 `__MSG_*__` 引用

## Architecture

```
Pi 会话（.pi/extensions/pi-browser-agent，注册 browser_* 工具）
        │  WebSocket JSON-RPC (V2) / native messaging (V1 legacy)
        ▼
ws://127.0.0.1:16789 (fallback 16799)  ← 本地 Relay（旧默认 16799 易与本机其他中继客户端冲突，故默认 16789）
        ▲
Chrome 扩展 SW (background.js, service worker, MV3)
   ├─ 连接管理：discover/reconnect（alarms 每 30s + 激进轮询窗口）
   ├─ 工具分发：Ho 冻结映射表（含 `/tab` 专用的内部 `tabs_activate` handler）
   ├─ CDP 通道：chrome.debugger attach/detach、console/network 抓取、文件上传、导航
   ├─ Scripting 通道：chrome.scripting.executeScript 优先，失败回退 CDP Runtime.evaluate
   ├─ 状态：tabs Map、console/network 环形缓冲（上限 Pn/$n）、beforeunload 策略、截图上下文
   └─ Popup 消息桥：getState / retryRelay / attachTab / detachTab / openBrowserTabInChat

Popup (popup.html + popup.js)  ← chrome.runtime.onMessage 读状态、触发连接/断开
Content scripts（document_idle 注入，__piBrowser* 全局单例）：
   ├─ accessibility-tree.js  → __piBrowserAccessibilityTree（无 a11y 依赖的 DOM 角色树 + ref_N 句柄 + 元素搜索）
   ├─ page-bridge.js        → __piBrowserBridge（正文抽取 getPageText / 元素查找 searchElements）
   └─ visual-indicator.js   → __piBrowserVisualIndicator（高亮框 + 状态徽标 + 自动化横幅，Shadow DOM 隔离）
```

工具列表（`background.js` 内 `Ho` 表）：`computer, read_page, find, form_input, navigate, javascript_tool, get_page_text, file_upload, resize_window, read_console_messages, read_network_requests, tabs_context, tabs_activate, tabs_context_mcp, tabs_create, tabs_create_mcp, tabs_close_mcp`。其中 `tabs_activate` 只供用户触发的 Pi `/tab` 命令经 Transport 调用，不注册为模型可调用的 `browser_*` 工具。
V2 另有 `browser-tab-handoff`（listTabs / captureContext / openInChat）跨客户端移交链路。

## Entry Points

- 扩展：`manifest.json` → `background` SW、`action.default_popup`、`content_scripts` 三段
- Pi 侧：`.pi/extensions/pi-browser-agent/index.ts`（`registerBrowserAgentTools` + `/tab` 注册）
- 用户命令：`.pi/extensions/pi-browser-agent/tab-command.ts`（选择器、安全显示文本、会话默认目标）
- 运维入口：`.pi/docs/pi-browser-agent/README.md`（能力边界 + 权限模型）、`tab-switch-live-test-runbook.md`（`/tab` 实机验收）与 `m3-live-test-runbook.md`（通用真验证步骤）

## Directory Map

| 路径 | 职责 |
| --- | --- |
| `manifest.json` | MV3 清单：权限（debugger/tabs/scripting/nativeMessaging 等）、SW、popup、三个 content scripts、`<all_urls>` host 权限 |
| `background.js` | ★ 核心 SW（已压缩 bundle）：relay 连接、工具执行、CDP/scripting 双通道、文件上传（ref 直填 + triggerRef 菜单兜底）、console/network 抓取、beforeunload 自动处理；以三个最小接线点引用 `tabs_activate` |
| `background-tab-activation.js` | 可读原生 ESM：严格校验 `tabId`，调用 `chrome.tabs.update(..., { active: true })`；不聚焦操作系统窗口 |
| `popup.html` / `popup.js` | 工具栏弹窗 UI（332px 卡片，语义色 token 在 `:root`）；显示中继/活动标签连接状态，发起连接/断开/交给聊天 |
| `content-scripts/accessibility-tree.js` | DOM→角色树 + 稳定 `ref_N` 句柄（跨次 snapshot 失效即 stale） |
| `content-scripts/page-bridge.js` | 正文抽取（article/main 等选择器优先，兜底 body） |
| `content-scripts/visual-indicator.js` | 绿色脉冲高亮、加载徽标、“查”懒惰（Shadow DOM 防样式污染） |
| `_locales/{en,zh_CN}/` | 扩展 UI 文案（83 条键） |
| `icons/`、`pi-logo.png` | 品牌资源 |
| `.pi/extensions/pi-browser-agent/` | **Pi 侧 TypeScript 源**：`index.ts`（注册工具/命令）、`tab-command.ts`（`/tab` 与会话目标）、`tools.ts`（参数/校验/默认目标路由）、`transport.ts`+`local-relay-transport.ts`+`minimal-ws.ts`（传输/WS 最小实现）、`protocol.ts`（错误/结果信封）、`policy.ts`（权限）、`audit.ts`（会话审计环，上限 200）、`legacy-envelope.ts`（V1 兼容） |
| `.pi/extensions/pi-browser-agent/*.test.ts` | Bun 单测：background-tab-activation / tab-command / protocol / tools / legacy-envelope / integration / ready-wait / remap / index / extension-bundle / local-relay-transport |
| `.pi/extensions/pi-browser-agent/live-*.ts`、`m2/m3-*` | 真浏览器联调脚本（live-smoke、m2/m3 里程碑） |
| `.pi/docs/pi-browser-agent/` | 本文档家族：`README.md`（边界/权限/测试）、`tab-switch-live-test-runbook.md`（`/tab` 验收）、`m3-live-test-runbook.md`（通用实机步骤）、`troubleshooting.md`（排障）、本文件 |
| `.gitignore` | 忽略 `.pi/research/ext-load-check/`（测试 Chrome profile，含 Cookie，敏感且为缓存） |

## Key Workflows

- **Pi 发起工具调用**：`browser_*` 工具 → transport（local-relay）→ SW `Ho[tool]` handler → scripting/CDP → 结果回传（`content`+`isError` 信封，错误码带 `retryable`）
- **用户切换默认标签页**：`/tab` → `waitForIdle` → `tabs_context` → 安全选择器 → 内部 `tabs_activate` → 成功后提交会话目标 → 后续 `BrowserRequestContext.tabId`；显式工具参数始终优先，Esc/失败不改状态
- **导航**：`navigate` 校验 URL（仅 http/https + back/forward）→ `chrome.tabs.update/create` → 等 `complete` → beforeunload 自动处理（策略按 tab 记录）
- **表单/点击**：`ref_N` 由 `browser_page_snapshot` 产生，仅对该 `snapshotId` 有效；失效返回 `stale_element_ref`，需重新快照
- **文件上传**：`ref`（直接 `DOM.setFileInputFiles`）或 `triggerRef`（点按钮 → 拦 fileChooser → 找“上传文件”菜单兜底）— 均带事件/网络诊断回报
- **连接保活**：SW 启动即 `Oa()` 启动；`chrome.alarms` 每 0.5 分钟 `Ue()` 巡检；popup 可触发激进轮询

## Conventions

- **改哪里**：浏览器行为改 `background.js`/content scripts 时要知道它们是 bundle；结构与 API 演进应先在 `.pi/extensions/pi-browser-agent/`（源）落地并补测试，再同步 bundle 产物。
- **错误语义**：Pi 侧统一 `createErrorResult({code, retryable, suggestion})`；扩展侧文本前缀 `[PiBrowserBridge V2]/[Ext]` 与 `[PiBrowserBridge]`（content script）区分。
- **权限**：写操作默认要 session/site grant 或 UI 确认；敏感字段名（password/token/secret/api key/authorization/cookie/credential）强制确认；无 UI 且无授权则拒绝且入审计。
- **URL 安全**：仅 chrome://、chrome-extension://、about:、devtools:、view-source:、javascript: 为受限，`attachTab` 直接抛错。
- **红线**：`.pi/research/ext-load-check/`（真实浏览器 profile）已在 `.gitignore`，不要把任何 Cookie/Login Data 提交进仓库。

## Validation Commands

```powershell
# 仓库根（Bun 测试；.pi 为隐藏目录，需显式枚举）
$tests = Get-ChildItem ./.pi/extensions/pi-browser-agent/*.test.ts |
  ForEach-Object { $_.FullName }
bun test @tests

# `/tab` 聚焦回归
bun test ./.pi/extensions/pi-browser-agent/background-tab-activation.test.ts `
          ./.pi/extensions/pi-browser-agent/tab-command.test.ts `
          ./.pi/extensions/pi-browser-agent/tools.test.ts `
          ./.pi/extensions/pi-browser-agent/integration.test.ts `
          ./.pi/extensions/pi-browser-agent/extension-bundle.test.ts

# 扩展实机加载：chrome://extensions/ → 开发者模式 → 加载本目录
# `/tab` 验收：严格执行 tab-switch-live-test-runbook.md
```

## Where To Change Common Things

| 需求 | 位置 |
| --- | --- |
| 新增一个浏览器工具 | Pi 侧 `index.ts` 注册 + `tools.ts` handler；扩展侧 `background.js` `Ho` 表 + SW 逻辑；补两个测试 |
| 修改 `/tab` 选择与默认目标 | `tab-command.ts`、`tools.ts`、`index.ts`；同步 `tab-command.test.ts` 与 `integration.test.ts` |
| 改中继端口/主机 | `background.js` 内 16789/16799 常量；Pi 侧 env：`PI_BROWSER_RELAY_PORT`/`PI_BROWSER_RELAY_HOST`（仅回环） |
| 改 popup 外观/文案 | `popup.html`（`:root` token + 类名）与 `_locales/*/messages.json` |
| 调正文抽取启发式 | `content-scripts/page-bridge.js` 选择器列表 |
| 调 a11y 树角色映射/ref 规则 | `content-scripts/accessibility-tree.js` |
| 调权限/审计策略 | `.pi/extensions/pi-browser-agent/policy.ts`、`audit.ts` |
| 排连接故障 | `.pi/docs/pi-browser-agent/troubleshooting.md`；诊断脚本 `diag-sw.ts` |

## Open Questions

- `background.js`/`popup.js` 为 bundle，**源码上游未在本仓库**——若需大规模重构，需先确定是否引入真实构建链路或仅接受产物级维护。
- R20 高权限能力（任意 JS、Cookie/网络读）已刻意未注册；启用前需显式设计评审（见 README）。
- 16789/16799 存在端口冲突历史，改动端口前需核对本机是否有其他中继客户端占用。
- `browser_screenshot` 目前只报能力声明（不可用 warning），非真截图。
