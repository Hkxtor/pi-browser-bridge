import { describe, expect, it } from "bun:test";
import { ActionAudit } from "./audit";
import { createRequestContext } from "./protocol";
import {
	handleBrowserPageSnapshot,
	handleBrowserPageText,
	handleBrowserTabsList,
	handleElementClick,
} from "./tools";
import { MockBrowserTransport, UnconfiguredBrowserTransport } from "./transport";

function baseTools() {
	return [
		{ name: "tabs_context", description: "", inputSchema: { type: "object", properties: {}, additionalProperties: false }, risk: "read" as const },
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
		expect(await transport.discoverTools()).toHaveLength(5);

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

	it("unconfigured transport fails the whole flow closed", async () => {
		const transport = new UnconfiguredBrowserTransport();
		const error = await transport.connect().catch((e: unknown) => e);
		expect((error as { code: string }).code).toBe("controller_transport_unconfigured");
	});
});
