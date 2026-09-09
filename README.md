# Pi Browser Bridge

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/Hkxtor/pi-browser-bridge?include_prereleases)](https://github.com/Hkxtor/pi-browser-bridge/releases)
[![Chrome MV3](https://img.shields.io/badge/manifest-V3-blue.svg)](manifest.json)

**English → [README.en.md](README.en.md)**

> 让 [Pi](https://github.com/earendil-works/pi-coding-agent) 编程 Agent 直接「看见并操作」你正在使用的 Chrome 浏览器 —— 通过一枚 MV3 Chrome 扩展 + 一个本地 WebSocket 中继（默认端口 **16789**），Pi 可以读页面、列标签页、生成无障碍树快照、点击元素、填写表单。

本仓库包含两个相互配套的部件：

| 部件 | 位置 | 说明 |
|---|---|---|
| **Chrome MV3 扩展** | 仓库根目录 | 连接本地中继、执行浏览器操作、Popup 状态面板 |
| **Pi 扩展** | `.pi/extensions/pi-browser-agent/` | 向 Pi 注册 `browser_*` 系列工具，是本方案的 Agent 侧入口 |

---

## 工作原理

```
Pi 会话（browser_* 工具）
    │  WebSocket JSON-RPC (V2 协议)
    ▼
ws://127.0.0.1:16789/extension/v2      ← 本地中继（Pi 侧启动监听）
    ▲
Chrome 扩展 Service Worker (background.js)
    ├─ chrome.debugger (CDP) 通道：控制台/网络抓取、导航、文件上传
    ├─ chrome.scripting 通道：页面内脚本执行（失败自动回退 CDP）
    └─ 三个 Content Scripts：
         accessibility-tree.js → DOM → 角色树 + ref_N 元素句柄
         page-bridge.js        → 正文抽取
         visual-indicator.js   → 操作时的绿色高亮与状态徽标（Shadow DOM 隔离）
```

- 中继**只监听回环地址**（`127.0.0.1`），不暴露到局域网。
- 扩展启动后自动探测 `16789`（优先）与 `16799`（向后兼容旧版 Pi）两个端口。

## 快速开始

### 1. 加载 Chrome 扩展

1. 打开 Chrome，访问 `chrome://extensions/`
2. 打开右上角「**开发者模式**」
3. 点击「**加载已解压的扩展程序**」，选择本仓库根目录
4. 工具栏出现 Pi 图标即安装成功（可点图标固定到工具栏）

### 2. 启用 Pi 侧扩展

本仓库的 `.pi/extensions/pi-browser-agent/` 会被 Pi 自动发现。在其他项目中使用时，可临时加载：

```bash
pi -e ./.pi/extensions/pi-browser-agent/index.ts
```

Pi 启动后会**异步**在 `127.0.0.1:16789` 开始监听，不会阻塞启动。

### 3. 验证连通

在 Pi 会话中直接提问，Agent 会依次调用工具：

```
浏览器桥接现在连通了吗？
```

或等待 Agent 自行调用 `browser_connection_status`：

- ✅ `connected` —— 链路就绪
- ❌ `port_unavailable` / 超时 —— 见 [故障排查](#故障排查)

### 4. 日常使用示例

对 Pi 说人话即可，例如：

> - 「列出我当前打开的所有标签页」→ `browser_tabs_list`
> - 「把当前页面的正文读给我」→ `browser_page_text`
> - 「给当前页面生成一个无障碍树快照」→ `browser_page_snapshot`
> - 「点击快照中 ref_7 那个按钮」→ `browser_element_click`
> - 「在搜索框（ref_3）填入『hello world』并提交」→ `browser_element_fill`

写操作（点击 / 填表）默认需要授权确认，见下文权限模型。

## 工具一览

| 工具 | 类型 | 说明 |
|---|---|---|
| `browser_connection_status` | 只读 | 报告连接状态，不发起网络连接 |
| `browser_discover_tools` | 只读 | 经传输层发现对端能力 |
| `browser_tabs_list` | 只读 | 标签页列表，标注活动标签页 |
| `browser_page_text` | 只读 | 标题 / URL / 正文（`maxChars` 截断，默认 50,000） |
| `browser_page_snapshot` | 只读 | 无障碍树快照，返回 `snapshotId` + `ref_N` 元素引用 |
| `browser_screenshot` | 只读 | 当前仅为能力声明：不可用时返回 warning，不算失败 |
| `browser_element_click` | 写 | 按 `ref` 点击；需授权或 UI 确认 |
| `browser_element_fill` | 写 | 按 `ref` 填文本；敏感字段强制确认，值不落明文日志 |
| `browser_element_scroll` | 写 | 将元素滚动到可视区域 |

> ⚠️ **快照失效**：`ref_N` 只对产生它的 `snapshotId` 有效。页面刷新或 DOM 重建后旧 ref 失效，工具返回 `stale_element_ref`（不可自动重试）——重新调用 `browser_page_snapshot` 拿新快照再操作即可。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PI_BROWSER_TRANSPORT` | `local-relay` | `local-relay` 开监听；`unconfigured` 回退骨架模式（不联网） |
| `PI_BROWSER_RELAY_PORT` | `16789` | 中继端口（旧默认 16799 易与本机其他中继客户端冲突，故改为 16789） |
| `PI_BROWSER_RELAY_HOST` | `127.0.0.1` | 仅允许回环地址（`127.0.0.1` / `localhost` / `::1`），其他值会被拒绝 |

## 权限与安全模型

- **写操作需授权**：会话级授权（sessionGranted）或站点级授权（目标 host 在 grantedHosts 内）方可执行；交互模式下会弹出 UI 确认。
- **敏感字段强制确认**：名称含 `password` / `token` / `secret` / `api key` / `authorization` / `cookie` / `credential` 的输入目标一律要求显式确认；无 UI 环境直接拒绝。
- **拒绝即无副作用**：任何被权限层拒绝的操作不会产生浏览器副作用，且与成功操作一并写入**会话内审计环**（默认上限 200 条，会话结束即丢弃）。
- **URL 黑名单**：`chrome://`、`chrome-extension://`、`about:`、`devtools:`、`view-source:`、`javascript:` 页面禁止 attach。
- **刻意未注册的能力**：任意 JS 执行、Cookie / 网络读取等高权限能力（R20）默认不开放，如需启用须经显式设计评审。

## 故障排查

| 现象 | 原因与解法 |
|---|---|
| `port_unavailable` | 端口被占用。查看占用方：`lsof -i :16789`（macOS/Linux）或 `Get-NetTCPConnection -LocalPort 16789`（Windows）；或用 `PI_BROWSER_RELAY_PORT=<空闲端口>` 换端口 |
| `controller_transport_unconfigured` | `PI_BROWSER_TRANSPORT=unconfigured` 生效或拼写错误，检查环境变量 |
| `stale_element_ref` | 快照已过期，重新 `browser_page_snapshot` 再重试 |
| `tab_not_found` | 目标 `tabId` 已关闭；先 `browser_tabs_list` 选存在的标签 |
| 一直连接不上 | 确认扩展已在 `chrome://extensions` 加载并启用；点扩展图标打开 Popup 查看中继状态并手动重连 |

更完整的排障手册：[.pi/docs/pi-browser-agent/troubleshooting.md](.pi/docs/pi-browser-agent/troubleshooting.md)

## 开发与测试

仓库为**无构建步**结构：根目录 JS（`background.js`、`popup.js`、`content-scripts/*.js`）是可直接加载的产物；可读的 TypeScript 源码与测试在 `.pi/extensions/pi-browser-agent/`。

```bash
# 运行单元测试（.pi 为隐藏目录，bun test 需显式路径）
bun test ./.pi/extensions/pi-browser-agent/protocol.test.ts \
         ./.pi/extensions/pi-browser-agent/tools.test.ts \
         ./.pi/extensions/pi-browser-agent/legacy-envelope.test.ts \
         ./.pi/extensions/pi-browser-agent/integration.test.ts
```

更多开发细节：

- 架构导览与新手上路：[.pi/docs/pi-browser-agent/onboarding.md](.pi/docs/pi-browser-agent/onboarding.md)
- 能力边界与错误码：[.pi/docs/pi-browser-agent/README.md](.pi/docs/pi-browser-agent/README.md)
- 真机联调手册：[.pi/docs/pi-browser-agent/m3-live-test-runbook.md](.pi/docs/pi-browser-agent/m3-live-test-runbook.md)

## 目录速览

```
chrome-extension/
├── manifest.json                  # MV3 清单（扩展 v1.5.8）
├── background.js                  # Service Worker：中继连接 / 工具分发 / CDP+scripting 双通道
├── popup.html / popup.js          # 工具栏弹窗：连接状态 + 手动连接/断开
├── content-scripts/
│   ├── accessibility-tree.js      # DOM → 角色树 + ref_N 句柄
│   ├── page-bridge.js             # 正文抽取
│   └── visual-indicator.js        # 操作高亮 / 状态徽标
├── _locales/{en,zh_CN}/           # 扩展 UI 文案（中英双语）
├── icons/                         # 扩展图标
└── .pi/
    ├── extensions/pi-browser-agent/   # Pi 侧 TypeScript 源码 + 测试 + 联调脚本
    └── docs/pi-browser-agent/         # 运维与开发文档族
```

## 许可证

[MIT](LICENSE)
