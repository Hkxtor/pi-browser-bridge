# Pi Browser Agent（当前能力边界）

> 新成员入口：[onboarding.md](./onboarding.md)（架构、目录地图、验证命令、改动指引）。
> `/tab` 实机验收：[tab-switch-live-test-runbook.md](./tab-switch-live-test-runbook.md)。

Pi 浏览器 Agent 扩展。**当前默认状态**：启动本机 Relay 服务（`ws://127.0.0.1:16789/extension/v2`），等待真实 Chrome 扩展主动连入。工具、权限、审计、错误、取消及 `/tab` 核心语义已有自动化覆盖；真实 `/tab` 联动必须按 runbook 在隔离 Chrome profile 中验证并留下脱敏证据。

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PI_BROWSER_TRANSPORT` | `local-relay` | `local-relay` 开监听；`unconfigured` 回退骨架（不联网） |
| `PI_BROWSER_RELAY_PORT` | `16789` | 默认 16789（旧默认 16799 易与本机其他中继客户端冲突） |
| `PI_BROWSER_RELAY_HOST` | `127.0.0.1` | 只允许回环地址（`127.0.0.1`/`localhost`/`::1`），其他值会被拒绝 |
| `PI_BROWSER_READY_TIMEOUT_MS` | `8000` | 等待 Chrome 扩展就绪的上限；`0` 表示不等待，最大 30,000ms |

默认启后也是**异步启动监听**，不阻塞 Pi 启动；端口被占用时 `browser_connection_status` 会报告 `port_unavailable`。

## 安装与加载

```powershell
# 项目自动发现（将目录放在仓库下即可）
.pi/extensions/pi-browser-agent/index.ts

# 或临时加载
pi -e ./.pi/extensions/pi-browser-agent/index.ts
```

## `/tab` 命令

在 Pi 交互会话中输入无参数命令：

```text
/tab
```

- 命令直接运行，不向 LLM 发送消息，也不会启动 Agent turn。
- 选择器显示安全截断后的标题、URL 和稳定 `tabId`；`[ACTIVE]` 表示 Chrome 窗口内活跃页，`[TARGET]` 表示 Pi 会话默认目标。
- 上下键移动、Enter 激活、Esc 取消。取消、空列表或激活失败都不会改变原目标。
- 成功后，未显式传 `tabId` 的 page text、snapshot、screenshot、click、fill、scroll 默认使用所选标签页；显式 `tabId` 始终优先。
- 目标只保存在当前 Pi 扩展实例中，关闭/切换会话后清除。
- 命令只令标签页成为其 Chrome 窗口内 active；**不会把 Chrome 窗口提升到操作系统前台**。
- `/tab` 不接受 ID、标题、URL、`next` 或 `prev` 参数；传参时仅显示 `Usage: /tab`。

`tabs_activate` 是 `/tab` 经 Transport 调用的内部桥能力，不注册为模型可调用的 `browser_*` 工具。

## 工具清单

| 工具 | 类型 | 说明 |
|---|---|---|
| `browser_connection_status` | 只读 | 报告连接状态，不联网 |
| `browser_discover_tools` | 只读 | 经 Transport 发现能力 |
| `browser_tabs_list` | 只读 | 标签页列表，标注活动标签页 |
| `browser_page_text` | 只读 | 标题/URL/正文；`maxChars` 截断（默认 50,000） |
| `browser_page_snapshot` | 只读 | Accessibility Tree，`snapshotId` + `ref_N` |
| `browser_screenshot` | 只读 | 当前为能力声明：不可用时返回 warning |
| `browser_element_click` | 写 | 按 ref 点击；需权限授权或 UI 确认 |
| `browser_element_fill` | 写 | 按 ref 填文本；敏感目标强制确认，值不落明文 |
| `browser_element_scroll` | 写 | 滚动到元素 |

## 权限模型

- 会话授权（sessionGranted）或站点授权（grantedHosts 含目标 host）→ 允许。
- 敏感字段（password/token/secret/api key/authorization/cookie/credential）→ 必须 `require_confirm`；无 UI 时拒绝。
- 无授权且无 UI → 拒绝，不执行副作用。
- 拒绝与成功都写入会话内审计环（默认上限 200，关会话即弃）。

## 快照 / 引用失效（stale_element_ref）

- `ref_N` 只对产生它的 `snapshotId` 有效；页面刷新或 DOM 重建后旧 ref 失效。
- 失配返回 `stale_element_ref`（不可自动重试）。恢复方式：重新 `browser_page_snapshot`，用新的 `snapshotId`/`ref` 重试。

## 错误码（当前骨架）

`controller_transport_unconfigured`（未配置）、`browser_not_ready` / `client_not_connected`（扩展未就绪）、`tool_not_found`（旧扩展缺少能力）、`permission_denied`、`stale_element_ref`、`tab_not_found`、`cancelled`、`timeout`、`invalid_transport_result`、`internal_error` 等；每个错误带 `retryable` 与恢复建议。`/tab` 专项恢复步骤见 [troubleshooting.md](./troubleshooting.md)。

## 已知边界

- **真实拨号检查**：默认在 127.0.0.1:16789 等扩展连入；如果没有安装扩展（或端口被占用），工具表现仍是超时或不可连接，不会崩溃。
- **真实 `/tab` 验收**：自动化测试不替代 Chrome/TUI 联测；发布前按 [tab-switch-live-test-runbook.md](./tab-switch-live-test-runbook.md) 执行。
- R20 高权限能力（任意 JS、文件上传、Cookie/网络读取）未注册，后续如需需通过显式设计评审。
- 测试运行于显式路径（`.pi` 隐藏目录在根目录 `bun test` 中不可发现）。

## 测试

```powershell
# `/tab` 聚焦回归
bun test ./.pi/extensions/pi-browser-agent/background-tab-activation.test.ts `
          ./.pi/extensions/pi-browser-agent/tab-command.test.ts `
          ./.pi/extensions/pi-browser-agent/tools.test.ts `
          ./.pi/extensions/pi-browser-agent/integration.test.ts `
          ./.pi/extensions/pi-browser-agent/extension-bundle.test.ts

# 全量：显式枚举隐藏目录中的测试文件，避免根目录 bun test 漏测
$tests = Get-ChildItem ./.pi/extensions/pi-browser-agent/*.test.ts |
  ForEach-Object { $_.FullName }
bun test @tests
```

真实 Chrome 验证执行 [tab-switch-live-test-runbook.md](./tab-switch-live-test-runbook.md)。
