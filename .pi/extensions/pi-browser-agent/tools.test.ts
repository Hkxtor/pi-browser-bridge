import { describe, expect, it } from "bun:test";
import {
	BrowserTransportError,
	createErrorResult,
	createRequestContext,
	truncateText,
} from "./protocol";
import { ActionAudit } from "./audit";
import { decideWritePermission, isSensitiveTarget, redactValue } from "./policy";
import {
	handleBrowserPageSnapshot,
	handleBrowserPageText,
	handleBrowserScreenshot,
	handleBrowserTabsList,
	handleElementClick,
	handleElementFill,
} from "./tools";
import { MockBrowserTransport, UnconfiguredBrowserTransport } from "./transport";

const request = createRequestContext({ requestId: "call-1", sessionId: "session-1" });

function connectedMock() {
	return new MockBrowserTransport({
		tools: [
			{ name: "tabs_context", description: "tabs", inputSchema: { type: "object", properties: {}, additionalProperties: false }, risk: "read" },
			{ name: "get_page_text", description: "page text", inputSchema: { type: "object", properties: { tabId: { type: "number" } }, required: ["tabId"] }, risk: "read" },
			{ name: "read_page", description: "accessibility", inputSchema: { type: "object", required: ["tabId"] }, risk: "read" },
			{ name: "computer", description: "actions", inputSchema: { type: "object", required: ["action", "tabId"] }, risk: "write" },
			{ name: "form_input", description: "fill", inputSchema: { type: "object", required: ["ref", "value", "tabId"] }, risk: "write" },
		],
		tabsContextText:
			'Open tabs (2):\n\n1. [280923130] "Example" [ACTIVE]\n   https://example.com\n2. [280923131] "Docs"\n   https://docs.example',
		pageTextOutput: "Title: Example\nURL: https://example.com/\nSource: body\n\n" + "x".repeat(200),
		pageTreeText: 'Page accessibility tree (2 elements shown, filter: interactive):\n\n    [ref_1] button "Submit"\n      [ref_2] textbox "Email"',
		computerResult: "Screenshot failed: Only screenshots from surface are allowed.",
	} as Parameters<typeof MockBrowserTransport.prototype.constructor>[0]);
}

describe("truncate helper", () => {
	it("keeps short text unchanged", () => {
		expect(truncateText("hello", 10)).toEqual({ text: "hello", truncated: false, originalLength: 5 });
	});

	it("truncates long text and reports original length", () => {
		const result = truncateText("x".repeat(200), 50);
		expect(result.text).toHaveLength(50);
		expect(result.truncated).toBe(true);
		expect(result.originalLength).toBe(200);
	});
});

describe("browser_tabs_list", () => {
	it("returns tabs with the active tab identified", async () => {
		const transport = connectedMock();
		await transport.connect();

		const result = await handleBrowserTabsList(transport, request);

		expect(result.status).toBe("success");
		expect(result.summary).toContain("2");
		expect(result.summary).toContain("Example");
		const evidence = result.evidence as { tabs: { tabId: number; active: boolean }[] };
		expect(evidence.tabs).toHaveLength(2);
		expect(evidence.tabs.find((t) => t.active)?.tabId).toBe(280923130);
	});
});

describe("browser_page_text", () => {
	it("returns title, url and bounded text with truncation markers", async () => {
		const transport = connectedMock();
		await transport.connect();

		const result = await handleBrowserPageText(transport, request, { tabId: 1, maxChars: 50 });
		const evidence = result.evidence as {
			title: string;
			url: string;
			text: string;
			truncated: boolean;
			originalLength: number;
		};

		expect(result.status).toBe("success");
		expect(evidence.title).toBe("Example");
		expect(evidence.url).toBe("https://example.com/");
		expect(evidence.text).toHaveLength(50);
		expect(evidence.truncated).toBe(true);
	});

	it("maps a missing tab to a coded error", async () => {
		const transport = connectedMock();
		await transport.connect();
		transport.failures["get_page_text"] = new BrowserTransportError(
			"tab_not_found",
			"Tab not found.",
			false,
		);

		const error = await handleBrowserPageText(transport, request, { maxChars: 50 }).catch((e) => e);
		expect(error).toBeInstanceOf(BrowserTransportError);
		expect(error.code).toBe("tab_not_found");
	});
});

describe("browser_page_snapshot", () => {
	it("returns a snapshot with snapshotId and element refs", async () => {
		const transport = connectedMock();
		await transport.connect();

		const result = await handleBrowserPageSnapshot(transport, request, { tabId: 1, maxChars: 10_000 });
		const evidence = result.evidence as {
			snapshotId: string;
			elements: { ref: string; role: string }[];
		};

		expect(result.status).toBe("success");
		expect(evidence.snapshotId).toMatch(/^live-/);
		expect(evidence.elements.map((e) => e.ref)).toEqual(["ref_1", "ref_2"]);
	});
});

describe("browser_screenshot", () => {
	it("reports screenshot result via computer(action=screenshot)", async () => {
		const transport = connectedMock();
		await transport.connect();

		const result = await handleBrowserScreenshot(transport, request);
		// 真实扩展此场景下返回错误文本 —— 目前是预期的失败路径
		expect(result.status).toBe("success");
		expect(JSON.stringify(result.evidence)).toContain("Only screenshots from surface are allowed");
	});
});

describe("cancellation and stale refs", () => {
	it("rejects with code cancelled when the signal is already aborted", async () => {
		const transport = connectedMock();
		await transport.connect();
		const controller = new AbortController();
		controller.abort();

		const error = await handleBrowserPageText(transport, request, {}, controller.signal).catch(
			(e) => e,
		);
		expect(error.code).toBe("cancelled");
	});

	it("keeps stale_element_ref as a stable non-retryable error code", () => {
		const result = createErrorResult(
			new BrowserTransportError("stale_element_ref", "Element reference is stale.", false),
		);
		expect(result.error).toEqual({ code: "stale_element_ref", retryable: false });
	});
});

describe("write permission policy", () => {
	const action = { kind: "click" as const, snapshotId: "snap-1", ref: "ref_1" };

	it("denies write actions without grant and without UI", () => {
		expect(decideWritePermission(action, { sessionGranted: false, grantedHosts: [], hasUI: false })).toBe(
			"deny",
		);
	});

	it("allows write actions under a session grant", () => {
		expect(decideWritePermission(action, { sessionGranted: true, grantedHosts: [], hasUI: false })).toBe(
			"allow",
		);
	});

	it("allows write actions on site-granted hosts", () => {
		expect(
			decideWritePermission(
				{ ...action, url: "https://example.com/form" },
				{ sessionGranted: false, grantedHosts: ["example.com"], hasUI: false },
			),
		).toBe("allow");
	});

	it("requires confirmation for sensitive targets when UI exists", () => {
		expect(
			decideWritePermission(
				{ ...action, kind: "fill", targetName: "password field", value: "hunter2" },
				{ sessionGranted: true, grantedHosts: [], hasUI: true },
			),
		).toBe("require_confirm");
	});

	it("denies sensitive targets when no UI exists", () => {
		expect(
			decideWritePermission(
				{ ...action, kind: "fill", targetName: "API token", value: "tok_live_123" },
				{ sessionGranted: true, grantedHosts: [], hasUI: true === false },
			),
		).toBe("deny");
	});

	it("detects sensitive names and values and redacts them", () => {
		expect(isSensitiveTarget("Password", undefined)).toBe(true);
		expect(isSensitiveTarget(undefined, "authorization: Bearer abc")).toBe(true);
		expect(isSensitiveTarget("email", "user@example.com")).toBe(false);
		expect(redactValue("tok_live_123456")).not.toContain("tok_live_123456");
	});
});

describe("write operation handlers", () => {
	function writeMock(currentSnapshotId = "snap-1") {
		return new MockBrowserTransport({
			tools: [
				{ name: "computer", description: "click/scroll", inputSchema: {}, risk: "write" },
				{ name: "form_input", description: "fill", inputSchema: {}, risk: "write" },
			],
			currentSnapshotId,
		});
	}

	it("denies click without permission and performs no side effect", async () => {
		const transport = writeMock();
		await transport.connect();
		const audit = new ActionAudit();
		const policy = { sessionGranted: false, grantedHosts: [], hasUI: false };

		const error = await handleElementClick(
			transport,
			request,
			{ snapshotId: "snap-1", ref: "ref_1", url: "https://example.com" },
			policy,
			audit,
		).catch((e) => e);

		expect(error.code).toBe("permission_denied");
		expect(transport.invocations.filter((i) => i.toolName === "computer")).toHaveLength(0);
		expect(audit.entries.at(-1)?.decision).toBe("deny");
	});

	it("click succeeds with a session grant and records audit", async () => {
		const transport = writeMock();
		await transport.connect();
		const audit = new ActionAudit();
		const policy = { sessionGranted: true, grantedHosts: [], hasUI: false };

		const result = await handleElementClick(
			transport,
			request,
			{ snapshotId: "snap-1", ref: "ref_1" },
			policy,
			audit,
		);

		expect(result.status).toBe("success");
		expect(transport.invocations.some((i) => i.toolName === "computer")).toBe(true);
		expect(audit.entries.at(-1)?.result).toBe("success");
	});

	it("deny path requires confirmFn approval for sensitive fill values", async () => {
		const transport = writeMock();
		transport.options.formInputResult = "field filled";
		await transport.connect();
		const audit = new ActionAudit();
		const policy = { sessionGranted: true, grantedHosts: [], hasUI: true };

		const error = await handleElementFill(
			transport,
			request,
			{ snapshotId: "snap-1", ref: "ref_2", text: "tok_live_secret", targetName: "API token" },
			policy,
			audit,
			undefined,
			async () => false,
		).catch((e) => e);

		expect(error.code).toBe("permission_denied");
		expect(transport.invocations.filter((i) => i.toolName === "form_input")).toHaveLength(0);
		const entry = audit.entries.at(-1);
		expect(JSON.stringify(entry)).not.toContain("tok_live_secret");
	});

	it("confirmed sensitive fill proceeds and the audit value is redacted", async () => {
		const transport = writeMock();
		transport.options.formInputResult = "field filled";
		await transport.connect();
		const audit = new ActionAudit();
		const policy = { sessionGranted: true, grantedHosts: [], hasUI: true };

		await handleElementFill(
			transport,
			request,
			{ snapshotId: "snap-1", ref: "ref_2", text: "tok_live_secret", targetName: "API token" },
			policy,
			audit,
			undefined,
			async () => true,
		);

		expect(transport.invocations.some((i) => i.toolName === "form_input")).toBe(true);
		const entry = audit.entries.at(-1);
		expect(entry?.decision).toBe("allow");
		expect(JSON.stringify(entry)).not.toContain("tok_live_secret");
	});

	it("stale snapshot id maps to stale_element_ref at the transport level", async () => {
		const transport = writeMock("snap-2");
		transport.options.computerResult = "clicked";
		await transport.connect();

		const error = await transport
			.invoke(
				"computer",
				{ action: "left_click", ref: "ref_1", tabId: 1, snapshotId: "snap-1" },
				request,
			)
			.catch((e) => e);

		expect(error.code).toBe("stale_element_ref");
	});

	it("audit keeps only the most recent entries within the ring limit", () => {
		const audit = new ActionAudit(5);
		for (let i = 0; i < 8; i++) {
			audit.record({
				action: "click",
				ref: `ref_${i}`,
				snapshotId: "snap-1",
				decision: "allow",
				result: "success",
			});
		}
		expect(audit.entries).toHaveLength(5);
		expect(audit.entries[0].ref).toBe("ref_3");
		expect(audit.entries.at(-1)?.ref).toBe("ref_7");
	});
});

describe("unconfigured transport", () => {
	it("rejects read tools instead of connecting implicitly", async () => {
		const transport = new UnconfiguredBrowserTransport();
		const error = await handleBrowserTabsList(transport, request).catch((e) => e);
		expect(error.code).toBe("controller_transport_unconfigured");
	});
});

describe("ready wait integration", () => {
	/** 在 mock 上记录 connect/waitForReady/invoke 的调用顺序 */
	function tracedMock() {
		const transport = connectedMock();
		const events: string[] = [];
		const origConnect = transport.connect.bind(transport);
		const origWait = transport.waitForReady.bind(transport);
		const origInvoke = transport.invoke.bind(transport);
		transport.connect = async (signal) => { events.push("connect"); return origConnect(signal); };
		transport.waitForReady = async (signal) => { events.push("waitForReady"); return origWait(signal); };
		transport.invoke = async (name, args, ctx, signal) => { events.push("invoke"); return origInvoke(name, args, ctx, signal); };
		return { transport, events };
	}

	it("read tools run connect → waitForReady → invoke exactly once", async () => {
		const { transport, events } = tracedMock();

		const result = await handleBrowserTabsList(transport, request);

		expect(result.status).toBe("success");
		expect(events).toEqual(["connect", "waitForReady", "invoke"]);
	});

	it("denied write returns permission_denied immediately without waiting for readiness", async () => {
		const { transport, events } = tracedMock();
		const audit = new ActionAudit();
		const policy = { sessionGranted: false, grantedHosts: [], hasUI: false };

		const error = await handleElementClick(
			transport,
			request,
			{ snapshotId: "snap-1", ref: "ref_1" },
			policy,
			audit,
		).catch((e) => e);

		expect(error.code).toBe("permission_denied");
		// 不得有任何 transport 连接/等待行为
		expect(events).toEqual([]);
		expect(transport.waitForReadyCalls).toBe(0);
	});

	it("granted write runs connect → waitForReady → invoke exactly once", async () => {
		const { transport, events } = tracedMock();
		transport.options.computerResult = "clicked";
		const audit = new ActionAudit();
		const policy = { sessionGranted: true, grantedHosts: [], hasUI: false };

		const result = await handleElementClick(
			transport,
			request,
			{ snapshotId: "snap-1", ref: "ref_1" },
			policy,
			audit,
		);

		expect(result.status).toBe("success");
		expect(events).toEqual(["connect", "waitForReady", "invoke"]);
	});
});
