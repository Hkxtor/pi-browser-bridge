# Implementation Plan: Pi 浏览器标签切换 M2 验证与文档收尾

> Source: `.pi/prds/pi-browser-tab-switch-command.prd.md`
>
> Selected milestone: **M2** — 补齐自动化测试、真实 Chrome 冒烟验证、README 与排障文档。
>
> Milestone selection note: PRD 表格仍把 M1 标为 `pending`，但当前工作树已包含 M1 实现，且 `.pi/tdd/pi-browser-tab-switch-command.tdd.md` 记录了 122 个自动化测试通过。实施 M2 时先重新验证该基线；若基线失败，不得直接把 M1/M2 标为完成。

## Requirements
- 保持 M1 已实现的 `/tab`、`tabs_activate`、会话默认 `tabId` 路由和“不聚焦操作系统窗口”行为不变；M2 不扩展 `/tab <id|标题|URL>`、`next`、`prev` 或跨会话持久化。
- 补齐自动化覆盖中尚未直接证明的用户流程：成功切换后再次打开 `/tab` 的 `[ACTIVE]`/`[TARGET]` 标记、warming 提示只出现一次，以及状态化列表在激活后的变化。
- 自动化测试必须继续证明 `/tab` 不发送用户消息、不启动 Agent turn；显式 `tabId` 仍优先于会话默认目标；失败不会提交新目标或自动选择替代标签页。
- 新增一份面向 `/tab` 的真实 Chrome 联测 runbook，使用隔离 Chrome profile、至少两个公开且非敏感的测试页面，以及默认回环 Relay `127.0.0.1:16789`。
- 真实联测必须覆盖：连接与能力发现、键盘选择、切换成功、再次打开选择器、无显式 `tabId` 的 page text/snapshot 路由、Esc 取消、标签关闭竞态、断连/超时，以及 Chrome 窗口不被带到操作系统前台。
- 联测证据必须记录环境、步骤、期望、实际结果和脱敏后的输出；不得提交 Cookie、Login Data、个人标签页标题/URL 或隔离 Chrome profile。
- README 必须说明 `/tab` 的用法、连接前提、标记含义、会话内默认目标、显式 `tabId` 优先级和“不前置窗口”边界。
- onboarding 必须补充 `background-tab-activation.js`、`tab-command.ts`、`/tab` 数据流、验证命令和常见改动入口。
- troubleshooting 必须补充 `/tab` 的 `browser_not_ready`/`client_not_connected`、`tool_not_found`、`tab_not_found`、无 UI、命令重名后缀等恢复路径，并删除或改写已过时的“真实 Transport 尚未接入”说明。
- 只有自动化验证、文档链接检查和真实 Chrome 冒烟证据全部通过后，才把 PRD 的 M1/M2 状态更新为完成；若环境阻塞，M2 保持 pending 并在证据文件中写明阻塞原因。

## Patterns To Mirror
| Category | Source | Pattern |
|---|---|---|
| Naming | `.pi/extensions/pi-browser-agent/ready-wait-live-test.ts`、`m2-live-test.ts`、`.pi/docs/pi-browser-agent/m3-live-test-runbook.md` | 测试文件与主题同目录，使用 kebab-case；真实联测文档使用 `{feature}-live-test-runbook.md`，证据使用 `.pi/tdd/{feature}-m2.tdd.md`。 |
| Errors | `.pi/extensions/pi-browser-agent/protocol.ts`、`legacy-envelope.ts`、`tab-command.ts`；`.pi/docs/pi-browser-agent/troubleshooting.md` 的按错误码分节 | 保留 snake_case 稳定码、`retryable` 和明确恢复建议；文档按“原因/恢复”说明，不把失败写成成功。 |
| Logging | `.pi/extensions/pi-browser-agent/live-smoke.ts` 的 `[live-smoke]` 前缀；`m2-live-test.ts` 的时间戳 `emit()` | 仓库没有通用业务 logger。自动化测试使用断言；联测过程用短前缀或时间戳记录，并将最终、脱敏结论写入 TDD 证据。 |
| Data access | `.pi/extensions/pi-browser-agent/transport.ts`、`local-relay-transport.ts`、`tools.ts` | 不新增平行浏览器数据源；验证仍通过 `BrowserTransport` 和现有 handler。隔离 profile 继续放在已忽略的 `.pi/research/ext-load-check/`，不得读取或提交真实用户资料。 |
| Tests | `tab-command.test.ts`、`tools.test.ts`、`integration.test.ts`、`extension-bundle.test.ts` | 使用 `bun:test`、同目录 fake/fixture、`MockBrowserTransport.invocations`、稳定错误码与无副作用断言；`.pi` 隐藏目录测试必须显式列出。 |
| Runbook | `.pi/docs/pi-browser-agent/m3-live-test-runbook.md` | 每步写明前提、操作、预期、取证落点和失败退出条件；联测发现只记录，不在实机验证过程中临时修代码。 |
| Documentation | `.pi/docs/pi-browser-agent/README.md` 的配置/工具/边界/测试结构；`onboarding.md` 的目录地图/工作流/验证/改动指引 | 在现有章节中增量补充，保持中文说明和表格风格。仓库目前没有专门的 slash-command 使用章节；新增 `/tab` 小节时明确这是新文档模式。 |

## Files To Change
| File | Action | Why |
|---|---|---|
| `.pi/extensions/pi-browser-agent/tab-command.test.ts` | Modify | 增加 warming 单次提示、连续执行 `/tab` 后 `[ACTIVE]`/`[TARGET]` 标记和无 Agent turn 的回归覆盖。 |
| `.pi/extensions/pi-browser-agent/integration.test.ts` | Modify | 用 stateful fake transport 覆盖“列表状态变化 → 激活 → 再次列表 → 无显式 `tabId` 读取”的完整 M2 自动化链路。 |
| `.pi/extensions/pi-browser-agent/tab-command.ts` | Modify only if RED requires | 仅当新增测试复现行为偏差时做最小修复；不得借 M2 增加参数模式或持久化。 |
| `.pi/extensions/pi-browser-agent/tools.ts` | Modify only if RED requires | 仅修复由新增回归或真实联测证明的协议/默认目标问题，不扩大工具面。 |
| `.pi/extensions/pi-browser-agent/index.ts` | Modify only if RED requires | 仅修复命令注册、单一状态实例或 shutdown 清理的可复现问题。 |
| `.pi/docs/pi-browser-agent/tab-switch-live-test-runbook.md` | Add | 定义隔离 Chrome 环境下 `/tab` 的人工冒烟步骤、证据模板、隐私边界和停止条件。 |
| `.pi/docs/pi-browser-agent/README.md` | Modify | 增加 `/tab` 用户说明、语义边界、错误恢复入口，并更新显式测试命令。 |
| `.pi/docs/pi-browser-agent/onboarding.md` | Modify | 更新目录地图、核心工作流、验证命令及“修改标签选择行为”的文件指引。 |
| `.pi/docs/pi-browser-agent/troubleshooting.md` | Modify | 增加 `/tab` 专项错误恢复，纠正真实 Relay/扩展已接入后的过时状态说明。 |
| `.pi/tdd/pi-browser-tab-switch-command-m2.tdd.md` | Add | 保存 M2 自动化与真实 Chrome 的脱敏证据、环境信息、结果和未决项。 |
| `.pi/prds/pi-browser-tab-switch-command.prd.md` | Modify | 在全部门禁通过后更新 M1/M2 状态并链接计划/证据；阻塞时保持 M2 pending。 |

## Tasks
1. **重新确认 M1 基线并建立 M2 缺口清单。**
   - 运行现有 `background-tab-activation`、`tab-command`、`tools`、`integration`、`extension-bundle` 测试及浏览器 Agent 全量测试。
   - 对照 PRD R1–R13 和现有 TDD 证据，确认 M1 代码仍存在且绿色；记录 M2 只剩自动化补强、真实 Chrome 证据和文档。
   - 检查工作树，保护既有未提交 M1 改动；不得在 M2 计划执行中覆盖或重排压缩 bundle。

2. **RED：补齐连续选择与 warming 状态的命令测试。**
   - 在 `tab-command.test.ts` 增加 stateful tabs fixture：第一次列表中 A 为 active，选择 B 并激活后，第二次 `/tab` 中 B 同时显示 `[ACTIVE]` 与 `[TARGET]`。
   - 断言 warming 状态只产生一次等待提示，随后仍按 `connect → waitForReady → tabs_context` 执行；超时继续保持旧目标。
   - 保留零次 `sendUserMessage`/Agent 调用断言，并确认 Esc、空列表和错误路径没有 `tabs_activate` 副作用。

3. **GREEN/REFACTOR：只修复新增测试暴露的最小偏差。**
   - 优先调整 fake/stateful fixture；只有生产行为确实不符合 PRD 时才修改 `tab-command.ts`、`tools.ts` 或 `index.ts`。
   - 保持无参数 `/tab`、会话内状态、显式 `tabId` 优先和稳定错误码不变。
   - 每个修复后先重跑对应 RED 测试，再运行既有聚焦测试；不做无关命名、协议或 bundle 重构。

4. **补齐状态化集成覆盖。**
   - 在 `integration.test.ts` 让 fake `tabs_activate` 更新后续 `tabs_context` 的 active 状态。
   - 验证再次运行 `/tab` 时标记反映真实 active 与 Pi target；随后 `browser_page_text` 和 `browser_page_snapshot` 在未传 `tabId` 时都携带所选 ID。
   - 验证标签在确认前关闭时只调用一次 `tabs_activate`，返回 `tab_not_found`，目标和后续默认路由均不被替换。

5. **编写 `/tab` 真实 Chrome 联测 runbook。**
   - 复用 `m3-live-test-runbook.md` 的章节结构：环境基线、隔离 Chrome 启动、Pi 启动、步骤/预期/取证、失败退出条件、收尾。
   - 规定只使用 `.pi/research/ext-load-check/` 隔离 profile 和公开测试页面；明确禁止提交 profile、Cookie、登录数据及未脱敏标签信息。
   - 覆盖连接、`tabs_activate` 能力发现、键盘导航、成功切换、再次选择器标记、隐式 page text/snapshot、Esc、关闭标签竞态、断连超时和窗口不前置。
   - 对命令冲突检查 Pi 实际注册名；若出现 `/tab:1` 等后缀，记录加载来源和文档差异，不静默假设 `/tab` 唯一。

6. **执行真实 Chrome 冒烟并形成证据。**
   - 在操作员确认的隔离 Chrome 实例中执行 runbook；不得停止或重配置占用其他端口的中继客户端。
   - 将环境版本、端口、扩展加载方式、每步期望/实际、脱敏输出和 PASS/BLOCKED 结论写入 `.pi/tdd/pi-browser-tab-switch-command-m2.tdd.md`。
   - 若 Chrome、UI 或扩展连接不可用，记录阻塞点并停止；不得用 mock 结果冒充真实 Chrome 证据。
   - 联测中发现实现偏差时先记录并退出；另开修复循环后重新从受影响步骤开始验证。

7. **更新 README 与 onboarding。**
   - README 新增“`/tab` 命令”章节，说明无参数用法、选择器标记、连接要求、会话目标、显式 `tabId` 优先、取消语义及不前置窗口边界。
   - README 的错误码和测试命令纳入 `browser_not_ready`、`client_not_connected`、`tool_not_found`、新测试文件及真实联测 runbook。
   - onboarding 的目录地图加入 `background-tab-activation.js` 与 `tab-command.ts`；工作流加入 `/tab → tabs_context → tabs_activate → BrowserRequestContext.tabId`；验证和改动指引链接新 runbook。

8. **更新 troubleshooting 并清理过时表述。**
   - 为 `/tab` 补充无 UI、连接等待/超时、旧扩展缺少 `tabs_activate`、关闭标签和命令重名的“原因/恢复”条目。
   - 将 `tab_not_found` 的恢复建议改为优先重新运行 `/tab`，同时保留显式 `browser_tabs_list` 路径。
   - 改写“进行真实浏览器联测前”中 Transport 尚未实现的旧描述，使其与当前 local-relay 和已完成联测事实一致；不顺带改写无关历史记录。

9. **完成验证并更新里程碑状态。**
   - 运行新增测试、全部显式浏览器 Agent 测试、覆盖率、两个 Bun build smoke 和 `git diff --check`。
   - 检查 README/onboarding/troubleshooting/runbook 的相互链接及命令路径，确认没有个人路径、Cookie 或真实标签页数据。
   - 只有自动化与真实 Chrome 证据均为 PASS 时，才在 PRD 中把 M1、M2 标为完成并链接本计划及 M2 TDD 证据；否则保留 M2 pending 并写明 blocker。

## Validation
```bash
# 1. M2 聚焦回归
bun test ./.pi/extensions/pi-browser-agent/background-tab-activation.test.ts ./.pi/extensions/pi-browser-agent/tab-command.test.ts ./.pi/extensions/pi-browser-agent/tools.test.ts ./.pi/extensions/pi-browser-agent/integration.test.ts ./.pi/extensions/pi-browser-agent/extension-bundle.test.ts

# 2. 浏览器 Agent 全量回归（显式列出隐藏目录内测试）
bun test ./.pi/extensions/pi-browser-agent/background-tab-activation.test.ts ./.pi/extensions/pi-browser-agent/extension-bundle.test.ts ./.pi/extensions/pi-browser-agent/index.test.ts ./.pi/extensions/pi-browser-agent/integration.test.ts ./.pi/extensions/pi-browser-agent/legacy-envelope.test.ts ./.pi/extensions/pi-browser-agent/local-relay-transport.test.ts ./.pi/extensions/pi-browser-agent/protocol.test.ts ./.pi/extensions/pi-browser-agent/ready-wait.test.ts ./.pi/extensions/pi-browser-agent/remap.test.ts ./.pi/extensions/pi-browser-agent/tab-command.test.ts ./.pi/extensions/pi-browser-agent/tools.test.ts

# 3. 覆盖率
bun test --coverage ./.pi/extensions/pi-browser-agent/background-tab-activation.test.ts ./.pi/extensions/pi-browser-agent/extension-bundle.test.ts ./.pi/extensions/pi-browser-agent/index.test.ts ./.pi/extensions/pi-browser-agent/integration.test.ts ./.pi/extensions/pi-browser-agent/legacy-envelope.test.ts ./.pi/extensions/pi-browser-agent/local-relay-transport.test.ts ./.pi/extensions/pi-browser-agent/protocol.test.ts ./.pi/extensions/pi-browser-agent/ready-wait.test.ts ./.pi/extensions/pi-browser-agent/remap.test.ts ./.pi/extensions/pi-browser-agent/tab-command.test.ts ./.pi/extensions/pi-browser-agent/tools.test.ts

# 4. 模块构建 smoke（Pi 依赖保持 external；输出目录使用临时位置）
bun build ./.pi/extensions/pi-browser-agent/index.ts --target=bun --outdir ./.pi/research/ext-load-check/build-pi --external @earendil-works/pi-ai --external @earendil-works/pi-coding-agent
bun build ./background.js --target=browser --outdir ./.pi/research/ext-load-check/build-background

# 5. 补丁卫生
git diff --check

# 6. 真实 Chrome：严格执行并记录新 runbook
pi -e ./.pi/extensions/pi-browser-agent/index.ts
# 在 Pi TUI 中依次执行 /tab、browser_connection_status、browser_discover_tools、
# browser_page_text 与 browser_page_snapshot；证据写入 M2 TDD 文件。
```

## Risks
| Risk | Likelihood | Mitigation |
|---|---|---|
| PRD 仍把已实现的 M1 标为 pending，直接按表格可能重复开发或覆盖本地改动 | High | 以当前代码、绿色测试和 M1 TDD 证据为基线；M2 第一步先复核，再只补缺口。 |
| 真实 Chrome/交互式 TUI 在当前执行环境不可用 | Medium | 将真实冒烟设为硬门禁；记录 BLOCKED 和缺失条件，M2 保持 pending，不用 mock 冒充。 |
| 隔离浏览器 profile 或标签页证据泄露 Cookie、登录信息或个人 URL | High | 只用 `.pi/research/ext-load-check/` 隔离 profile和公开测试页；提交前扫描证据并脱敏，profile 永不入库。 |
| 16789/16799 与其他本机 Relay 并存导致连接到错误客户端 | Medium | 按现有 runbook 先核对端口和 browser client；不停止其他客户端，发现双控制面立即中止并记录。 |
| 手工冒烟容易漏掉 Esc、关闭竞态或“不前置窗口”边界 | Medium | runbook 使用逐项 PASS/FAIL 表和强制取证字段；任一步失败即停止，不跳步补结论。 |
| 文档继续保留“骨架/未接真实 Transport”等过时描述 | High | 对 README、onboarding、troubleshooting 做交叉审阅，并以当前 `local-relay-transport.ts` 和实机证据为事实来源。 |
| `/tab` 与其他扩展命令重名后实际入口带数字后缀 | Low | 联测前检查命令列表；记录实际命令名和来源，并在文档中说明 Pi 的后缀行为。 |
| M2 测试补强诱发不必要的生产代码重构 | Low | 坚持 RED 后最小 GREEN；若现有行为已满足测试，则只改测试、文档和证据。 |

## Acceptance
- [ ] Tasks complete
- [ ] Validation passes
- [ ] Pi patterns mirrored
- [ ] M1 基线重新验证为绿色，且没有为 M2 重写已完成的核心实现。
- [ ] 连续两次 `/tab` 的 active/target 标记、warming 提示和状态化默认路由有自动化覆盖。
- [ ] 全部浏览器 Agent 测试及覆盖率命令通过，两个 Bun build smoke 通过。
- [ ] 真实 Chrome runbook 已执行，所有必需步骤有脱敏 PASS 证据；若无法执行，M2 明确保留 pending。
- [ ] README、onboarding、troubleshooting 已说明 `/tab` 用法、连接要求、错误恢复、显式参数优先和不前置窗口边界。
- [ ] 没有提交隔离 profile、Cookie、登录信息、个人标签页标题/URL 或其他敏感浏览器数据。
- [ ] PRD 的 M1/M2 状态与实际证据一致，并链接计划及 M2 TDD 记录。

Waiting for confirmation: proceed, modify, or cancel.
