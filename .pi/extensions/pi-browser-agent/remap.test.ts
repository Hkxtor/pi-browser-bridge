import { describe, expect, it } from "bun:test";
import { BrowserTransportError, createRequestContext } from "./protocol";
import {
	handleBrowserPageSnapshot,
	handleBrowserPageText,
	handleBrowserTabsList,
	handleBrowserScreenshot,
	handleElementClick,
	handleElementFill,
	handleElementScroll,
} from "./tools";
import { ActionAudit } from "./audit";
import { MockBrowserTransport } from "./transport";

// 本测试文件以 M3 真实联测得到的 schema 为准。Tools 用真民：
// tabs_context / get_page_text(max_chars) / read_page / computer(action) / form_input /
// 错误之类的 "Unknown tool" / "Invalid arguments"。

function realSchemaMock(): MockBrowserTransport {
	return new MockBrowserTransport({
		tools: [
			{ name: "tabs_context", description: "", inputSchema: { type: "object", properties: {}, additionalProperties: false }, risk: "read" },
			{ name: "get_page_text", description: "", inputSchema: { type: "object", properties: { tabId: { type: "number" }, max_chars: { type: "integer" } }, required: ["tabId"] }, risk: "read" },
			{ name: "read_page", description: "", inputSchema: { type: "object", properties: { tabId: { type: "number" }, filter: { type: "string" }, depth: { type: "integer" }, max_chars: { type: "integer" }, ref_id: { type: "string" } }, required: ["tabId"] }, risk: "read" },
			{ name: "computer", description: "", inputSchema: { type: "object", properties: { action: { enum: ["click", "type", "scroll", "screenshot"] }, ref: { type: "string" }, coordinate: { type: "array" }, scroll_direction: { type: "string" }, scroll_amount: { type: "number" }, tabId: { type: "number" } }, required: ["action", "tabId"] }, risk: "write" },
			{ name: "form_input", description: "", inputSchema: { type: "object", properties: { ref: { type: "string" }, value: { type: "string" }, tabId: { type: "number" } }, required: ["ref", "value", "tabId"] }, risk: "write" },
		],
		tabs: undefined,
		pageText: undefined,
		snapshot: undefined,
		screenshot: undefined,
	} as Parameters<typeof MockBrowserTransport.prototype.constructor>[0]);
}

const request = createRequestContext({ requestId: "r", sessionId: "s" });

describe("real extension schema-driven remapping", () => {

	it("browser_tabs_list calls tabs_context and parses text output into tabs", async () => {
		const t = realSchemaMock();
		await t.connect();

		const result = await handleBrowserTabsList(t, request).catch((e) => e);
		expect((result as { status?: string }).status).toBe("success");
		const evidence = (result as { evidence?: { tabs: unknown[] } }).evidence;
		expect(Array.isArray(evidence?.tabs)).toBe(true);
		expect(evidence.tabs.length).toBeGreaterThanOrEqual(0);
	});

	it("browser_page_text calls get_page_text with max_chars (snake_case) not maxChars", async () => {
		const t = realSchemaMock();
		await t.connect();

		const result = await handleBrowserPageText(t, request, { maxChars: 100 }).catch((e) => e);
		expect((result as { status?: string }).status).toBe("success");
	});

	it("browser_page_snapshot calls read_page with tabId + optional filter", async () => {
		const t = realSchemaMock();
		await t.connect();

		const result = await handleBrowserPageSnapshot(t, request, { maxChars: 5_000 }).catch((e) => e);
		expect((result as { status?: string }).status).toBe("success");
	});

	it("browser_screenshot calls computer action=screenshot with tabId", async () => {
		const t = realSchemaMock();
		await t.connect();

		const result = await handleBrowserScreenshot(t, request).catch((e) => e);
		expect((result as { status?: string }).status).toBe("success");
	});

	it("browser_element_click uses computer action=click with ref", async () => {
		const t = realSchemaMock();
		await t.connect();
		const audit = new ActionAudit();
		const policy = { sessionGranted: true, grantedHosts: [], hasUI: false };

		const result = await handleElementClick(
			t,
			request,
			{ snapshotId: "", ref: "ref_1", tabId: 1 },
			policy,
			audit,
		).catch((e) => e);
		expect((result as { status?: string }).status).toBe("success");
	});

	it("browser_element_fill uses form_input with ref and value", async () => {
		const t = realSchemaMock();
		await t.connect();
		const audit = new ActionAudit();
		const policy = { sessionGranted: true, grantedHosts: [], hasUI: false };

		const result = await handleElementFill(
			t,
			request,
			{ snapshotId: "", ref: "password-ref", text: "the value", tabId: 1 },
			policy,
			audit,
		).catch((e) => e);
		expect((result as { status?: string }).status).toBe("success");
	});

	it("browser_element_scroll uses computer action=scroll", async () => {
		const t = realSchemaMock();
		await t.connect();
		const audit = new ActionAudit();
		const policy = { sessionGranted: true, grantedHosts: [], hasUI: false };

		const result = await handleElementScroll(
			t,
			request,
			{ snapshotId: "", ref: "ref_9", tabId: 1 },
			policy,
			audit,
		).catch((e) => e);
		expect((result as { status?: string }).status).toBe("success");
	});

	it("maps extension's 'Unknown tool' error to tool_not_found", async () => {
		const t = realSchemaMock();
		await t.connect();
		t.failures["get_page_text"] = new Error("Unknown tool: get_page_text") as unknown as BrowserTransportError;
		const error = await handleBrowserPageText(t, request, {}).catch((e) => e);
		expect((error as { code: string }).code).toBe("tool_not_found");
	});

	it("maps extension's 'Invalid arguments' error to invalid_arguments", async () => {
		const t = realSchemaMock();
		await t.connect();
		t.failures["get_page_text"] = new Error("Invalid arguments: maxChars is not supported") as unknown as BrowserTransportError;
		const error = await handleBrowserPageText(t, request, {}).catch((e) => e);
		expect((error as { code: string }).code).toBe("invalid_arguments");
	});
});
