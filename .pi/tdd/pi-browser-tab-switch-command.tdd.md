# Pi Browser Tab Switch Command — TDD Evidence

## Source plan

- [`.pi/plans/pi-browser-tab-switch-command.plan.md`](../plans/pi-browser-tab-switch-command.plan.md)
- Milestone: M1 only. Real Chrome smoke evidence and user-facing documentation remain pending for M2.

## Task report

1. **Chrome activation contract**
   - RED: missing `background-tab-activation.js` and missing bundle wiring caused the new tests to fail.
   - GREEN: added the strict `tabs_activate` schema and injected Chrome handler; wired one import, one discovery definition, and one handler-map entry into `background.js`.
   - Validation: `bun test ./.pi/extensions/pi-browser-agent/background-tab-activation.test.ts ./.pi/extensions/pi-browser-agent/extension-bundle.test.ts` (included in the focused and full runs below).

2. **Pi activation adapter and target routing**
   - RED: `handleBrowserTabActivate` was absent, context `tabId` was ignored, and screenshot errors collapsed `tab_not_found` into `screenshot_unavailable`.
   - GREEN: added activation response/error parsing, explicit-parameter precedence, context fallback for reads and writes, and stable stale-target propagation.
   - Validation: focused suite passed with 56 tests and 0 failures.

3. **`/tab` command and session state**
   - RED: `tab-command.ts` was absent.
   - GREEN: added command registration, idle waiting, interactive selection, safe bounded labels, cancellation/empty/error handling, and success-only state commit.
   - Validation: command tests cover usage, no-UI, empty list, Escape, timeout, unsupported capability, closed tab, no LLM call, and successful state update.

4. **Integration and regression coverage**
   - GREEN: added list → activate → implicit subsequent read coverage and verified that a closed selected tab neither changes state nor triggers fallback activation.
   - Validation: all browser-agent tests passed.

## Test specification

| # | What is guaranteed | Test file or command | Test type | Result | Evidence |
|---|---|---|---|---|---|
| 1 | `tabs_activate` accepts exactly one integer `tabId` | `background-tab-activation.test.ts` | Unit | Pass | Invalid/missing/extra arguments return `BAD_REQUEST`. |
| 2 | Chrome activates only the requested tab and never focuses a window | `background-tab-activation.test.ts` | Unit | Pass | Call order is `tabs.get` → `tabs.update({ active: true })`; no `windows.update`. |
| 3 | Closed tabs return `TAB_NOT_FOUND`; inactive final results are not reported as success | `background-tab-activation.test.ts` | Unit | Pass | Stable MCP error payload assertions. |
| 4 | Pi parses activation success and maps extension errors | `tools.test.ts` | Unit | Pass | Covers success, `TAB_NOT_FOUND`, unknown tool, malformed result. |
| 5 | Explicit `tabId` overrides session target; otherwise session target is used | `tools.test.ts` | Unit | Pass | Page text, snapshot, screenshot, click, fill, and scroll invocation assertions. |
| 6 | Invalid session targets do not silently fall back | `tools.test.ts`, `integration.test.ts` | Unit/integration | Pass | `tab_not_found` is preserved and no alternate activation occurs. |
| 7 | `/tab` does not trigger an Agent/LLM turn and commits state only after success | `tab-command.test.ts` | Unit | Pass | Fake `sendUserMessage` count remains zero; failure paths preserve old state. |
| 8 | Bundle wiring survives future bundle replacement | `extension-bundle.test.ts` | Contract | Pass | Static import, `Un` definition insertion, `Ut=Un.map(Wn)`, and `Ho` mapping asserted. |
| 9 | Full browser-agent regression remains green | enumerated `bun test` over `.pi/extensions/pi-browser-agent/*.test.ts` | Regression | Pass | 122 passed, 0 failed across 11 files. |
| 10 | Patch has no whitespace errors | `git diff --check` | Hygiene | Pass | Exit code 0. |

## Coverage and known gaps

- Command: Bun native test runner over all 11 `.test.ts` files with `--coverage`.
- Result: **94.43% functions**, **96.24% lines**; **122 passed, 0 failed**.
- On Windows PowerShell, the literal wildcard was not expanded, so the equivalent explicit file enumeration was used.
- TypeScript LSP validation was unavailable because the configured `biome` executable could not be started (`ENOENT`); Bun successfully transpiled and executed every test file that imports the changed testable modules.
- Per the M1 scope boundary, a real Chrome `/tab` smoke run, README/onboarding/troubleshooting updates, and broader compatibility evidence remain pending for M2.
