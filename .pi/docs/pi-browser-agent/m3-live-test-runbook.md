# M3 真实联测 Runbook（Pi ↔ Chrome 扩展）

> 来源：`.pi/plans/local-relay-transport-m3.plan.md`。每一步都列出**预期结果**与**取证落点**。
> 原则：联测里的发现只记录，不现场改代码；结构性偏差拆新里程碑。

## 0. 环境基线（已自动核验）

| 项 | 状态 |
|---|---|
| 扩展产物完整（manifest v1.5.8, MV3, background 135KB, popup, icons, 双语资源） | ✅ |
| 端口 16799 已被本机另一中继进程占用且已有 Established 连接 | ⚠️ 保留不动 |
| 端口 16789 空闲 | ✅ Pi 监听此口 |
| 本机占用 16799 的中继客户端保持运行 | ✅ **不动它**，并存联测 |

## 1. 选定方案（B）：dev instrumented 变体 + Pi 监听 16789（用户已确认）

- 本机其他中继客户端保持运行，不动 16799。
- Pi 用 `PI_BROWSER_RELAY_PORT=16789` 启动 Relay 监听。
- 独立 Chrome profile 加载本仓库扩展；经 **fallback 探测/直连**发现 16789，同时连 16789 上的 Pi Relay 与 16799 上原中继。
- **风险**：扩展同时接两个 Relay；若原客户端主动给扩展发 tools/invoke，两个控制面会并存。联测期间不主动操作原客户端，保持其被动。

## 2. Chrome 侧（半自动）

脚本化启动隔离实例（Pi 侧执行）：

```powershell
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

& $chrome `
  --user-data-dir="$env:TEMP\pi-browser-agent-chrome" `
  --load-extension="D:\pyproject\chrome-extension" `
  --remote-debugging-port=9222 `
  --no-first-run --no-default-browser-check `
  https://example.com
```

人工确认：扩展已启用（`chrome://extensions` 里 Pi Browser Bridge 存在且无报错）。

## 3. Pi 侧启动

```powershell
$env:PI_BROWSER_RELAY_PORT='16789'
pi -e ./.pi/extensions/pi-browser-agent/index.ts --list-models   # 加载烟囱
# 然后正常启动 pi -e ...（交互会话）
```

预期：Pi 监听 127.0.0.1:16789，扩展 fallback 探测到后接入。

## 4. 握手验证（Pi 提示词：`调用 browser_connection_status`）

预期：`status: success`，summary 包含 "connected"，evidence 里有 `transport: local-relay`。
取证：把完整工具输出复制进 `.pi/tdd/local-relay-transport-m3.tdd.md`。

## 5. tools/discover 与 schema 取证（`调用 browser_discover_tools`）

预期：工具列表与勘察一致（**至少** `computer`、`navigate`、`get_page_text`、`accessibility_tree`）。
取证：把每个工具的完整 schema（JSON）落到：

```
.pi/research/m3-discovered-tools/*.json
```

**偏差规则**：
- 多出一个新工具 → 记录，停手（不修复）。
- 少一个工具 → 记录，停手。
- 仅字段顺序/描述差异 → 记录即可。

## 6. 只读路径（以 example.com 为被测页面）

依次执行并记录：

| 工具 | 调用参数 | 预期 |
|---|---|---|
| `browser_tabs_list` | — | example.com 在列表中，active=true |
| `browser_page_text` | `{maxChars:1000}` | title="Example Domain"，text 非空 |
| `browser_page_snapshot` | `{maxChars:10000}` | snapshotId + refs |
| `browser_screenshot` | — | 返回 base64 image 或明确 warning |

## 7. 写路径（真实页面）

在 example.com 上选 `snapshot` 中的一个 link 的 ref：

1. `browser_element_click` **不带授权** → 预期 `permission_denied`，页面无变化。
2. 以确认授权（ctx.ui.confirm true）→ 预期点击生效（页面跳转）。
3. example.com 无表单——`fill` 用 `httpbin.org/forms/post`（或任何有 input 的页面）；敏感字段（name 含 password/token）强制 require_confirm。

每个动作后检查审计：`browser connection → audit entry 顺序`。

## 8. 故障路径

| 场景 | 期望 |
|---|---|
| 刷新页面后用旧 snapshotId 调用 `browser_element_click` | `stale_element_ref` |
| chrome://extensions 关掉扩展 → 在 Pi 上发起新调用 | `client_not_connected`（或 timeout → 若扩展侧无 disconnect callback） |
| 重新启用扩展 | 自动重连（extensionInfo 重新到达） |
| `Invoker.abort()` 中途取消 | `cancelled`；但浏览器侧动作可能已执行（**如实记录**） |
| 随意发格式错误 WS frame（压测扩展解析） | 不挂上本计划，除非影响正常路径 |

## 9. 真实错误码与超时取证

目标：从真实扩展看到 `QUEUE_FULL`、`COMMAND_TIMEOUT` 等的真实消息形态（如果本机联测打不出来，至少证实 **当且仅当** 联测能产生时它们按照我们的映射工作）。

取证：`.pi/research/m3-error-shape/*.json`（每个错误一次）。

## M3 联测结果（2026-09-04）

- 联测完成，成功打通：dev 扩展 → Pi 16789 Relay → tools/discover → navigate → get_page_text → read_page → read_console_messages → read_network_requests → find → computer(screenshot) → cancel
- 证据：`.pi/research/m3-live-final-report.txt`、`.pi/research/m3-capture/*.json`
- 发现：real discover 返回 **16 个工具**（非勘察推断的 5 个），`get_page_text` 不接受 `maxChars`——Pi 侧工具映射需要后续重构
- **注意**：原始扩展产物未动；dev-extension/ 是 patch 后的副本（1 处 native host + zh_CN extName/extDescription），能反复联测

## 10. 收尾

1. 把联测所有差异/观察记录到 `.pi/tdd/local-relay-transport-m3.tdd.md`。
2. 更新 `.pi/prds/local-relay-transport.prd.md` 的 M3 状态。
3. 若发现协议级偏差 → 拆新 PRD/里程碑；**不现场改实现**。

## 失败退出条件

- 无论一步出现"做不到这里"，该步骤把现状与下一步期望写进 tdd 证据文件，联测中止，评估是否要改路线（M2 的骨架/16789 fallback 不破坏）。

## 注意事项（计划未解决的开放问题）

- 扩展对所在端口的扫描优先级（fallback 探测顺序）。当前代码 `fallbackRelayPorts` 数组为空，所以 fallback 不在生产路径 —— 扩展只能连默认端口。这意味着：**占用默认端口的中继客户端要在联测期间停止**（见 §1）。
- `getRelayClients`（native host `com.pi.browser.bridge.connector`）在其他客户端占用默认端口时会失败；扩展的失败路径回退到 WS 直连本机端口即可接上 Pi，这是期望路径。
