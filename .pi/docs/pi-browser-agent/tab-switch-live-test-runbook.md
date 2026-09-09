# `/tab` 真实 Chrome 联测 Runbook

> 来源：`.pi/plans/pi-browser-tab-switch-command.plan.md`（M2）。
>
> 目标：用真实 Chrome 扩展和 Pi TUI 验证 `/tab` 的选择、激活、默认目标、取消和恢复路径。Mock/单测结果不能代替本 runbook 的实机证据。

## 0. 安全边界与停止条件

- 只使用公开测试页，例如 `https://example.com/` 和 `https://www.iana.org/domains/reserved`。
- Chrome profile 必须放在已忽略的 `.pi/research/ext-load-check/`；不得使用或提交个人浏览器 profile、Cookie、Login Data、个人标签标题或 URL。
- 不停止、不重配其他本机 Relay。优先使用 16789；若它无法绑定，可在确认 16799 空闲后使用扩展已支持的 16799 fallback，并在证据中记录偏差。扩展连接到无法识别的客户端时记录 BLOCKED 并停止。
- 联测中发现实现偏差时先记录，不现场修改代码；修复后从受影响步骤重新执行。
- 任一必需步骤无法执行时，M2 保持 pending，禁止用自动化测试结果替代真实 Chrome PASS。

## 1. 环境基线

在仓库根执行并把版本与结果写入 `.pi/tdd/pi-browser-tab-switch-command-m2.tdd.md`：

```powershell
bun --version
pi --version
git status --short
Get-NetTCPConnection -LocalPort 16789 -ErrorAction SilentlyContinue
```

预期：Bun 与 Pi 可用；已知工作树改动被记录；16789 可供本次 Pi Relay 使用，或已明确记录改用空闲 16799 fallback 的原因。

## 2. 启动隔离 Chrome

```powershell
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

$repo = (Resolve-Path ".").Path
$profile = Join-Path $repo ".pi\research\ext-load-check\tab-switch-m2"

& $chrome `
  --user-data-dir="$profile" `
  --load-extension="$repo" `
  --no-first-run --no-default-browser-check `
  "https://example.com/" `
  "https://www.iana.org/domains/reserved"
```

人工确认：

1. `chrome://extensions/` 中 Pi Browser Bridge 已启用且 Service Worker 无加载错误。
2. 两个公开测试页均已打开，其中只有一个是当前 Chrome 窗口内 active 标签页。
3. 关闭或最小化 Chrome 窗口后返回终端，后续用于验证命令不会把 Chrome 提升到操作系统前台。

## 3. 启动 Pi 并验证连接

```powershell
$env:PI_BROWSER_RELAY_PORT='16789' # 若预检确认改用 fallback，则设为 16799
pi -e ./.pi/extensions/pi-browser-agent/index.ts
```

在 Pi 中执行：

1. 调用 `browser_connection_status`。
2. 调用 `browser_discover_tools`。

预期：

- 连接状态为 `connected`，Transport 为 `local-relay`。
- discover 结果包含内部能力 `tabs_activate`。
- 如出现 `browser_not_ready`、`client_not_connected` 或 `port_unavailable`，转到 [troubleshooting.md](./troubleshooting.md)，记录 BLOCKED 后停止。

## 4. `/tab` 主链路

1. 输入 `/tab`。
2. 用上下键移动选择，确认列表包含标题、URL、`tabId`，当前 Chrome 活跃页带 `[ACTIVE]`。
3. 选择另一个非活跃公开测试页并按 Enter。
4. 记录 Pi 成功提示；提示必须包含所选标签页信息，但不得宣称 Chrome 窗口已被带到前台。
5. 确认 Chrome 窗口没有因命令被提升到操作系统前台；随后人工查看 Chrome，所选页应成为其窗口内 active 标签页。
6. 再次输入 `/tab`，确认同一项同时带 `[ACTIVE]` 与 `[TARGET]`，然后按 Esc 退出。

预期：Esc 不产生第二次激活，默认目标仍是刚才成功选择的标签页。

## 5. 默认目标路由

不传 `tabId`，依次调用：

1. `browser_page_text`（`maxChars: 1000`）。
2. `browser_page_snapshot`（`maxChars: 10000`）。

预期：两项结果的标题、URL 或页面内容都来自第 4 节选择的标签页。

然后显式传入另一个公开测试页的 `tabId` 再调用一次 `browser_page_text`。

预期：显式 `tabId` 覆盖 Pi 默认目标；默认目标本身不改变。

## 6. 取消与空列表

### Esc 取消

1. 记录当前 `[TARGET]`。
2. 输入 `/tab` 后按 Esc。
3. 再次输入 `/tab`。

预期：原 `[TARGET]` 保持不变，取消过程没有成功激活提示。

### 空列表

仅在可安全构造且不会影响其他客户端时执行。若扩展过滤后没有可操作页面，输入 `/tab`。

预期：显示明确的无标签页提示，不打开空选择器，不修改默认目标。无法安全构造时记录 `NOT RUN`，不得关闭非测试标签页。

## 7. 标签关闭竞态

1. 输入 `/tab` 并停留在选择器中。
2. 从隔离 Chrome 中关闭当前高亮但尚未确认的目标页。
3. 回到 Pi 按 Enter。

预期：

- 返回 `tab_not_found` 或等价稳定错误及恢复建议。
- 不自动激活其他标签页。
- 原 Pi 默认目标保持不变，Pi 会话继续可用。

## 8. 断连与有界等待

1. 在 `chrome://extensions/` 暂时停用或重载隔离实例中的扩展。
2. 输入 `/tab` 并记录开始/结束时间。
3. 等待配置的 `PI_BROWSER_READY_TIMEOUT_MS`（默认 8000ms）结束。

预期：先显示一次等待提示，随后返回 `browser_not_ready` 或 `client_not_connected` 及安装、启用或重连建议；命令不会无限挂起，默认目标不改变。

重新启用扩展，确认 `browser_connection_status` 恢复为 connected。

## 9. 旧扩展能力缺失（条件项）

仅当已有不含 `tabs_activate` 的安全旧版扩展副本时执行；不要现场删除当前 bundle 接线来制造场景。

预期：选择后返回 `tool_not_found`，提示更新或重载扩展，默认目标不改变。没有安全旧版副本时记录 `NOT RUN`，由自动化测试覆盖。

## 10. 证据模板

在 `.pi/tdd/pi-browser-tab-switch-command-m2.tdd.md` 记录：

```markdown
## Environment
- Date/time:
- OS:
- Chrome version:
- Extension manifest version:
- Pi version:
- Bun version:
- Relay host/port:
- Profile: isolated `.pi/research/ext-load-check/tab-switch-m2`

## Results
| Step | Expected | Actual | Result | Sanitized evidence |
|---|---|---|---|---|
| Connection | connected/local-relay | ... | PASS/BLOCKED | ... |
| Discovery | contains tabs_activate | ... | PASS/BLOCKED | ... |
| Select/activate | selected tab active; no OS focus | ... | PASS/BLOCKED | ... |
| Second selector | selected tab is ACTIVE + TARGET | ... | PASS/BLOCKED | ... |
| Implicit reads | page text/snapshot use selected tab | ... | PASS/BLOCKED | ... |
| Explicit override | explicit tabId wins | ... | PASS/BLOCKED | ... |
| Esc | no activation/state change | ... | PASS/BLOCKED | ... |
| Closed tab | tab_not_found; no fallback | ... | PASS/BLOCKED | ... |
| Disconnect | bounded wait + recovery advice | ... | PASS/BLOCKED | ... |

## Verdict
PASS or BLOCKED, with exact blocker and next action.
```

## 11. 收尾

1. 关闭 Pi，让 `session_shutdown` 清理 Transport 和会话目标。
2. 关闭隔离 Chrome；保留或删除 `.pi/research/ext-load-check/tab-switch-m2` 均不得影响仓库状态。
3. 运行 `git status --short --untracked-files=all`，确认没有 profile、Cookie、Login Data、个人 URL 或截图进入待提交文件。
4. 只有本 runbook 的必需步骤全部 PASS，才能把 PRD M2 标记为完成。
