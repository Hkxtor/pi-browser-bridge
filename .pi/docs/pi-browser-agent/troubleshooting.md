# Pi Browser Agent 故障排查

## 当前状态申明

截至本文件：Pi 默认在 **127.0.0.1:16789** 部署 WS 服务等待真实扩展连接（dev 模式安装 Chrome 扩展时会自动探测本机端口并接入）。骨架模式（不联网）可通过 `PI_BROWSER_TRANSPORT=unconfigured` 回退。

历史说明：旧默认端口 16799 常与本机其他中继客户端监听冲突（2026-09-07 实锤复现），故默认值改为 16789。

## 扩展侧端口探测事实（代码勘察 2026-09-07）

- 扩展 fallback 端口表 `ma = [16789, 16799]`（冻结、有序）：优先探测 16789，16799 向后兼容旧 Pi。
- **fallback 非空时完全取代 `defaultRelayPort`**（`dr()` 语义），故 background.js 中 `defaultRelayPort` 当前为死配置；M2 仍将其同步为 16789 以防数组被清空后行为分裂。
- `m3-live-test-runbook.md` §中“fallbackRelayPorts 数组为空”的描述**已过时**，以本勘察为准。

## 常见错误与恢复

### `controller_transport_unconfigured`
- **原因**：`PI_BROWSER_TRANSPORT=unconfigured` 生效或配置不合法导致回退。
- **恢复**：检查环境变量拼写；默认模式应为 `local-relay`。

### `port_unavailable`
- **原因**：端口已被占用。历史上最常见是本机另一中继客户端常驻监听旧的默认端口 16799；当前默认值已为 16789，若仍冲突说明 16789 也被占用。
- **恢复**：用 `PI_BROWSER_RELAY_PORT=<空闲端口>`（如 16791）或 `PI_BROWSER_TRANSPORT=unconfigured`；查看占用方：`Get-NetTCPConnection -LocalPort 16789` (Windows) / `lsof -i :16789` (macOS)。

### 控制台出现 `/extension` WebSocket 426
- **原因**：扩展未从 `GET /app/info` 获得 `v2-connection-status` 能力时，会额外尝试旧版状态桥 `ws://127.0.0.1:<port>/extension`；只接受 `/extension/v2` 的 Pi Relay 会以 HTTP 426 拒绝。主 V2 链路可能仍然可用，但控制台会持续产生噪声错误。
- **恢复**：更新后的 Relay 会在 `/app/info` 返回 `{ "relayCapabilities": ["v2-connection-status"] }`，扩展据此跳过旧版状态桥。修改生效需要重启 Pi 会话，然后在 `chrome://extensions` 重载扩展。

### `Unchecked runtime.lastError: Specified native messaging host not found`
- **原因**：当前机器未注册 `com.pi.browser.bridge.connector`，扩展的 Native Messaging 探测会异步断开；原 `onDisconnect` 回调虽能回退到端口探测，但未读取 `chrome.runtime.lastError`，因此 Chrome 把它报告为未处理错误。
- **恢复**：更新后的扩展会在回退前消费 `chrome.runtime.lastError`，不改变 fallback 行为。修改生效需要在 `chrome://extensions` 重载扩展；无需安装 Native Messaging host 即可继续使用 16789 本地 Relay。

### `permission_denied`
- **原因**：写操作缺授权或敏感目标无法在无 UI 场景确认。
- **恢复**：在交互模式允许 `ctx.ui.confirm`，或以会话级/站点级授权前置放行；拒绝路径不会产生浏览器副作用。

### `stale_element_ref`
- **原因**：`snapshotId` 与当前页面不一致（刷新 / DOM 重建 / 会话切换）。
- **恢复**：重新 `browser_page_snapshot` 获取新 `snapshotId` 与 `ref`，再用新引用重试。

### `tab_not_found`
- **原因**：目标 `tabId` 不存在或已关闭；未指定 `tabId` 时可能页面无活动标签。
- **恢复**：先 `browser_tabs_list`，选用存在的 `tabId` 或改用活动标签。

### `cancelled` / `timeout`
- **原因**：信号被 abort 或调用超时。
- **恢复**：确认连接稳定后重试；若是刻意取消，属正常路径。

## 截图不可用
- 原因：当前 Transport 无截图能力。
- 处置：`browser_screenshot` 会返回 warning 并说明下一步；不视为失败。

## 测试 / 验证环境问题

- **根目录 `bun test` 找不到测试**：`.pi` 隐藏目录默认不被发现，使用 README 中的显式相对路径。
- **LSP / `biome` 报错**：本仓库未安装 biome CLI；忽略或安装 `biome` 后运行。
- **`bun build` 要求 external**：依赖 `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent` 属 Pi 运行时外置依赖；构建命令需保持 `--external`。

## 进行真实浏览器联测前

1. 解析真实 controller 协议（endpoint、握手、tools/invoke envelope、取消）。
2. 将 `BrowserTransport` 替换为真实实现，保留 `policy.ts` / `audit.ts` / 错误映射不变。
3. 用 M1（协议勘察）中的 transport 矩阵复核 error/retry 语义。
4. 补充真实 Chrome 端到端验收（PRD 验收清单）后再解除骨架标注。
