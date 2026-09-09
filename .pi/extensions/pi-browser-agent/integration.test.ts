import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ActionAudit } from "./audit";
import { createRequestContext, createSuccessResult } from "./protocol";
import type { BrowserRequestContext, BrowserToolResult } from "./protocol";
import {
	handleBrowserPageSnapshot,
	handleBrowserPageText,
	handleBrowserTabsList,
	handleElementClick,
} from "./tools";
import {
	createBrowserTabTargetState,
	registerBrowserTabCommand,
} from "./tab-command";
import { MockBrowserTransport, UnconfiguredBrowserTransport } from "./transport";

function baseTools() {
	return [
		{ name: "tabs_context", description: "", inputSchema: { type: "object", properties: {}, additionalProperties: false }, risk: "read" as const },
		{ name: "tabs_activate", description: "", inputSchema: { type: "object", required: ["tabId"] }, risk: "write" as const },
		{ name: "get_page_text", description: "", inputSchema: { type: "object", properties: { tabId: { type: "number" } }, required: ["tabId"] }, risk: "read" as const },
		{ name: "read_page", description: "", inputSchema: { type: "object", required: ["tabId"] }, risk: "read" as const },
		{ name: "computer", description: "click/scroll", inputSchema: { type: "object", required: ["action", "tabId"] }, risk: "write" as const },
		{ name: "form_input", description: "fill", inputSchema: { type: "object", required: ["ref", "value", "tabId"] }, risk: "write" as const },
	];
}

class FullMock extends MockBrowserTransport {
	setSnapshotId(id: string): void {
		(this.options as { currentSnapshotId?: string }).currentSnapshotId = id;
	}
}

class StatefulTabMock extends MockBrowserTransport {
	private activeTabId = 11;

	override async invoke(
		toolName: string,
		arguments_: unknown,
		context: BrowserRequestContext,
		signal?: AbortSignal,
	): Promise<BrowserToolResult> {
		if (toolName === "tabs_context") {
			this.options.tabsContextText = [
				"Open tabs (2):",
				"",
				`1. [11] "Current"${this.activeTabId === 11 ? " [ACTIVE]" : ""}`,
				"   https://current.example/",
				`2. [22] "Selected"${this.activeTabId === 22 ? " [ACTIVE]" : ""}`,
				"   https://selected.example/",
			].join("\n");
		}
		if (toolName === "tabs_activate") {
			const tabId = (arguments_ as { tabId?: number }).tabId;
			this.options.tabActivateResult = createSuccessResult("activated", {
				content: [{
					type: "text",
					text: JSON.stringify({
						tabId,
						title: tabId === 22 ? "Selected" : "Current",
						url: tabId === 22 ? "https://selected.example/" : "https://current.example/",
						active: true,
					}),
				}],
			});
			const result = await super.invoke(toolName, arguments_, context, signal);
			if (typeof tabId === "number") this.activeTabId = tabId;
			return result;
		}
		return super.invoke(toolName, arguments_, context, signal);
	}
}

function connectedFullMock(currentSnapshotId = "snap-1") {
	return new FullMock({
		tools: baseTools(),
		currentSnapshotId,
		tabsContextText:
			'Open tabs (1):\n\n1. [280923130] "Example Domain" [ACTIVE]\n   https://example.com/',
		pageTextOutput: "Title: Example\nURL: https://example.com/\nSource: body\n\nBody text",
		pageTreeText: 'Page accessibility tree (1 element shown):\n\n    [ref_1] button "Submit"',
		computerResult: "ok",
		formInputResult: "filled",
		tabActivateResult: createSuccessResult("activated", {
			content: [{
				type: "text",
				text: JSON.stringify({
					tabId: 280923130,
					title: "Example Domain",
					url: "https://example.com/",
					active: true,
				}),
			}],
		}),
	});
}

function statefulTabMock() {
	return new StatefulTabMock({
		tools: baseTools(),
		pageTextOutput: "Title: Selected\nURL: https://selected.example/\nSource: body\n\nSelected body",
		pageTreeText: 'Page accessibility tree (1 element shown):\n\n    [ref_1] heading "Selected"',
	});
}

describe("end-to-end mock flow", () => {
	it("connects, discovers, reads, authorizes, clicks, and recovers from stale refs", async () => {
		const transport = connectedFullMock();
		const audit = new ActionAudit();
		const ctx = createRequestContext({ requestId: "flow-1", sessionId: "session-1", tabId: 1 });
		const noGrant = { sessionGranted: false, grantedHosts: [], hasUI: false };
		const granted = { ...noGrant, sessionGranted: true };

		await transport.connect();
		expect(transport.state).toBe("connected");
		expect(await transport.discoverTools()).toHaveLength(6);

		const tabs = await handleBrowserTabsList(transport, ctx);
		expect(tabs.status).toBe("success");

		const text = await handleBrowserPageText(transport, ctx, { maxChars: 100 });
		expect(text.status).toBe("success");

		const snapshot = await handleBrowserPageSnapshot(transport, ctx, { tabId: 280923130, maxChars: 10_000 });
		const snapId = (snapshot.evidence as { snapshotId: string }).snapshotId;
		expect(snapId).toMatch(/^live-/);

		// 未授权：无副作用
		const denied = await handleElementClick(
			transport, ctx, { snapshotId: "snap-1", ref: "ref_1" }, noGrant, audit,
		).catch((e: unknown) => e);
		expect((denied as { code: string }).code).toBe("permission_denied");
		expect(transport.invocations.filter((i) => i.toolName === "computer")).toHaveLength(0);

		// 授权后成功
		const ok = await handleElementClick(
			transport, ctx, { snapshotId: "snap-1", ref: "ref_1" }, granted, audit,
		);
		expect(ok.status).toBe("success");
		expect(transport.invocations.some((i) => i.toolName === "computer")).toBe(true);

		// transport 层的 stale 检查不依赖 handler 传入 snapshotId
		transport.setSnapshotId("snap-2");
		const stale = await transport
			.invoke(
				"computer",
				{ action: "left_click", ref: "ref_1", tabId: 1, snapshotId: "snap-1" },
				ctx,
			)
			.catch((e: unknown) => e);
		expect((stale as { code: string }).code).toBe("stale_element_ref");

		const recovered = await handleElementClick(
			transport, ctx, { snapshotId: "snap-2", ref: "ref_1" }, granted, audit,
		);
		expect(recovered.status).toBe("success");

		// 审计顺序（handler 级别，stale 是 transport 直查）: deny → success
		expect(audit.entries.map((e) => e.result)).toEqual([
			"permission_denied",
			"success",
			"success",
		]);

		// 取消
		const abort = new AbortController();
		abort.abort();
		const cancelled = await handleElementClick(
			transport, ctx, { snapshotId: "snap-2", ref: "ref_1" }, granted, audit, abort.signal,
		).catch((e: unknown) => e);
		expect((cancelled as { code: string }).code).toBe("cancelled");
	});

	it("routes a selected tab into the next read that omits tabId", async () => {
		const transport = connectedFullMock();
		const target = createBrowserTabTargetState();
		type TestCommand = { handler: (args: string, ctx: Record<string, unknown>) => Promise<void> };
		let command: TestCommand | undefined;
		const pi = {
			registerCommand(_name: string, definition: TestCommand) {
				command = definition;
			},
		} as unknown as ExtensionAPI;
		registerBrowserTabCommand(pi, transport, target);
		if (!command) throw new Error("tab command was not registered");

		await command.handler("", {
			mode: "tui",
			hasUI: true,
			waitForIdle: async () => {},
			ui: {
				select: async (_title: string, options: string[]) => options[0],
				notify: () => {},
			},
		});
		expect(target.get()).toBe(280923130);

		await handleBrowserPageText(
			transport,
			createRequestContext({
				requestId: "after-tab-command",
				sessionId: "session-1",
				tabId: target.get(),
			}),
			{ maxChars: 100 },
		);

		expect(transport.invocations.map((call) => [call.toolName, call.arguments])).toEqual([
			["tabs_context", {}],
			["tabs_activate", { tabId: 280923130 }],
			["get_page_text", { tabId: 280923130 }],
		]);
	});

	it("reflects activated and targeted state on a second chooser and routes both read handlers", async () => {
		const transport = statefulTabMock();
		const target = createBrowserTabTargetState();
		const chooserOptions: string[][] = [];
		let chooserCall = 0;
		type TestCommand = { handler: (args: string, ctx: Record<string, unknown>) => Promise<void> };
		let command: TestCommand | undefined;
		const pi = {
			registerCommand(_name: string, definition: TestCommand) {
				command = definition;
			},
		} as unknown as ExtensionAPI;
		registerBrowserTabCommand(pi, transport, target);
		if (!command) throw new Error("tab command was not registered");
		const context = {
			mode: "tui",
			hasUI: true,
			waitForIdle: async () => {},
			ui: {
				select: async (_title: string, options: string[]) => {
					chooserOptions.push(options);
					chooserCall++;
					return chooserCall === 1
						? options.find((option) => option.includes("[22]"))
						: undefined;
				},
				notify: () => {},
			},
		};

		await command.handler("", context);
		await command.handler("", context);

		expect(target.get()).toBe(22);
		const selectedOnSecondRun = chooserOptions[1].find((option) => option.includes("[22]"));
		expect(selectedOnSecondRun).toContain("[ACTIVE]");
		expect(selectedOnSecondRun).toContain("[TARGET]");

		const selectedContext = createRequestContext({
			requestId: "after-second-tab-command",
			sessionId: "session-1",
			tabId: target.get(),
		});
		await handleBrowserPageText(transport, selectedContext, { maxChars: 100 });
		await handleBrowserPageSnapshot(transport, selectedContext, { maxChars: 1000 });

		const readCalls = transport.invocations.filter((call) =>
			call.toolName === "get_page_text" || call.toolName === "read_page"
		);
		expect(readCalls.map((call) => call.arguments)).toEqual([
			{ tabId: 22 },
			{ tabId: 22 },
		]);
	});

	it("does not replace a closed selected tab with another target", async () => {
		const transport = connectedFullMock();
		transport.options.tabActivateResult = createSuccessResult("extension error", {
			content: [{
				type: "text",
				text: JSON.stringify({ error: { code: "TAB_NOT_FOUND", message: "Tab closed." } }),
			}],
			isError: true,
		});
		const target = createBrowserTabTargetState();
		target.set(7);
		type TestCommand = { handler: (args: string, ctx: Record<string, unknown>) => Promise<void> };
		let command: TestCommand | undefined;
		const pi = {
			registerCommand(_name: string, definition: TestCommand) {
				command = definition;
			},
		} as unknown as ExtensionAPI;
		registerBrowserTabCommand(pi, transport, target);
		if (!command) throw new Error("tab command was not registered");

		await command.handler("", {
			mode: "tui",
			hasUI: true,
			waitForIdle: async () => {},
			ui: {
				select: async (_title: string, options: string[]) => options[0],
				notify: () => {},
			},
		});

		expect(target.get()).toBe(7);
		expect(transport.invocations.filter((call) => call.toolName === "tabs_activate")).toHaveLength(1);
	});

	it("unconfigured transport fails the whole flow closed", async () => {
		const transport = new UnconfiguredBrowserTransport();
		const error = await transport.connect().catch((e: unknown) => e);
		expect((error as { code: string }).code).toBe("controller_transport_unconfigured");
	});
});
