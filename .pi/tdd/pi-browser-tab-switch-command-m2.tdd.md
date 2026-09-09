# Pi Browser Tab Switch Command — M2 Evidence

## Source

- PRD: [`.pi/prds/pi-browser-tab-switch-command.prd.md`](../prds/pi-browser-tab-switch-command.prd.md)
- Plan: [`.pi/plans/pi-browser-tab-switch-command.plan.md`](../plans/pi-browser-tab-switch-command.plan.md)
- Runbook: [`.pi/docs/pi-browser-agent/tab-switch-live-test-runbook.md`](../docs/pi-browser-agent/tab-switch-live-test-runbook.md)

## Environment

- Date/time: 2026-09-09T18:12:48+08:00
- OS: Microsoft Windows NT 10.0.22631.0
- Chrome: 110.0.5481.104
- Extension manifest: 0.0.1
- Pi: 0.85.1
- Bun: 1.3.14
- Chrome profile: isolated `.pi/research/ext-load-check/tab-switch-m2`
- Test pages: two public example-domain pages; no personal profile or authenticated page was used.
- Relay: 16789 could not be bound in this environment despite no visible listening process, so the documented fallback port 16799 was used for connected-browser checks. Port 16791 was used for the intentional disconnected timeout check.

## Automated regression

- M1 baseline before M2 additions: 122 passed, 0 failed across 11 files.
- Added M2 coverage:
  - second `/tab` invocation displays the selected tab as both `[ACTIVE]` and `[TARGET]`;
  - warming state emits one wait notification before Transport calls;
  - stateful integration routes both page text and snapshot to the selected `tabId`.
- Focused M2 test command: `bun test ./.pi/extensions/pi-browser-agent/tab-command.test.ts ./.pi/extensions/pi-browser-agent/integration.test.ts`.
- Focused result: 18 passed, 0 failed.

## Real Chrome results

Initial diagnosis of the user's active bridge returned 16 discovered tools and no `tabs_activate`, matching the reported `tool_not_found`. After the extension refresh, a follow-up discovery returned 17 tools with `tabs_activate` present, confirming that the stale-extension condition was resolved. The repository bundle contains the new import, discovery definition, and handler mapping exactly once.

| Step | Expected | Actual | Result | Sanitized evidence |
|---|---|---|---|---|
| Isolated extension load | Repository extension loads in a disposable profile | Chrome exposed one extension service worker and two public page targets through the isolated profile | PASS | CDP target summary contained one `service_worker` with `chrome-extension` URL kind and two HTTP pages. |
| Command registration | `/tab` is an extension command | RPC `get_commands` returned one extension command named `tab` | PASS | `commandRegistered=true` |
| Selection | `/tab` opens a selector with safe tab choices | RPC UI emitted two select options and accepted a non-active public test tab | PASS | `firstOptionCount=2`, `selectRequests=2` |
| Activation | Selected tab becomes active and command reports success | Success notification referenced the selected stable tab id | PASS | `selectedKnownPublicTab=true`, `successNotice=true` |
| Second selector | Selected tab is both Chrome active and Pi target | Second selector option contained `[ACTIVE]` and `[TARGET]` | PASS | `secondActiveTarget=true` |
| No Agent turn | `/tab` does not start an LLM turn | No `agent_start` event was emitted across both command invocations | PASS | `agentStarts=0` |
| Esc cancellation | Cancelling the second selector exits without another selection | RPC sent `cancelled: true`; command response completed normally | PASS | Second selector was cancelled after marker inspection. |
| Handler-level implicit reads | Activation is reflected by list, page text, and snapshot without explicit handler params | Real extension discovered `tabs_activate`; alternate safe tab activated; subsequent page text and snapshot succeeded using context target; original active tab restored | PASS | `safeTabCount=2`, both read statuses `success` |
| Bounded disconnected wait | `/tab` times out with recovery guidance and no Agent turn | On unused port 16791 with a 500ms configured wait, command returned `browser_not_ready` in 1358ms | PASS | `browserNotReadyNotice=true`, `agentStarts=0` |
| Keyboard up/down in native TUI | Arrow keys navigate and Enter confirms | RPC exercises the same `ctx.ui.select` contract but does not prove terminal key handling | NOT RUN | Requires a human-attended TUI run. |
| OS foreground behavior | Chrome is not raised to the foreground | Automated contract proves no `windows.update`; foreground state was not reliably observable in the headless harness | NOT RUN | Requires a human-attended desktop check. |
| Closed-tab race | Closing the highlighted tab yields `tab_not_found` and no fallback | Attempt stopped because the single-client Relay was superseded by another Chrome client and the selector no longer contained a known-safe public test tab | BLOCKED | No unknown/private option was selected; automated regression still covers this path. |
| Empty real tab list | Clear warning and no empty selector | Not safely constructible without affecting an unknown connected Chrome client | NOT RUN | Automated command test covers the empty list. |
| Legacy extension missing `tabs_activate` | `tool_not_found` and update/reload guidance | No safe legacy extension fixture was available | NOT RUN | Automated command/tool tests cover this path. |

## Final automated validation

- Focused M2 suite: **59 passed, 0 failed** across 5 files.
- Full browser-agent suite: **125 passed, 0 failed** across 11 files.
- Coverage: **94.49% functions**, **96.28% lines**.
- Pi extension build smoke: 11 modules bundled successfully with Pi runtime packages externalized.
- Chrome service-worker build smoke: 2 modules bundled successfully.
- Documentation validation: 5 files checked; no missing relative links or trailing whitespace; isolated profile path is ignored by Git.
- Patch hygiene: `git diff --check` passed.

## Validation notes

- The successful connected run used `node` to launch Pi RPC. Launching the Node-target Pi bundle through Bun failed during startup with `webidl.util.markAsUncloneable is not a function`; this was a harness/runtime mismatch, not a browser-agent failure.
- A competing Chrome extension client can supersede the isolated profile because `LocalRelayTransport` accepts one current client. The runbook must therefore stop if selector options do not match the known public test pages.
- The temporary helper script and isolated Chrome profile live under `.pi/research/ext-load-check/`, which is ignored by Git.

## Verdict

**BLOCKED** — the real connected command, activation, second-selector markers, no-Agent behavior, handler-level implicit reads, and bounded timeout all passed. Native TUI keyboard navigation, desktop foreground behavior, and the real closed-tab race still require a human-attended run with control over competing Chrome clients. M2 must remain pending until those required checks pass.
