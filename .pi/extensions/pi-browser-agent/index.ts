import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	BrowserTransportError,
	createErrorResult,
	createRequestContext,
	createSuccessResult,
	createWarningResult,
} from "./protocol";
import type { BrowserToolResult } from "./protocol";
import { createBrowserTransport, resolveSessionGrant, resolveTransportConfig } from "./config";
import { ActionAudit } from "./audit";
import {
	handleBrowserPageSnapshot,
	handleBrowserPageText,
	handleBrowserScreenshot,
	handleBrowserTabsList,
	handleElementClick,
	handleElementFill,
	handleElementScroll,
} from "./tools";
import type { BrowserTransport } from "./transport";
import { UnconfiguredBrowserTransport } from "./transport";

const EmptyParameters = Type.Object({});
const TabIdParameters = Type.Object({
	tabId: Type.Optional(Type.Number({ description: "Target tab id; defaults to the active browser tab." })),
});
const ReadParameters = Type.Object({
	tabId: Type.Optional(Type.Number({ description: "Target tab id; defaults to the active browser tab." })),
	maxChars: Type.Optional(
		Type.Number({ description: "Maximum characters to return; results are truncated with a marker.", default: 50_000 }),
	),
});
const ElementParameters = Type.Object({
	snapshotId: Type.String({ description: "Snapshot id from browser_page_snapshot; stale ids fail with stale_element_ref." }),
	ref: Type.String({ description: "Element ref from the snapshot, e.g. ref_3." }),
	tabId: Type.Optional(Type.Number({ description: "Target tab id; defaults to the active browser tab." })),
	url: Type.Optional(Type.String({ description: "Page URL for site-grant permission checks." })),
	targetName: Type.Optional(Type.String({ description: "Element name or label; used for sensitive-field detection." })),
});
const FillParameters = Type.Intersect([
	ElementParameters,
	Type.Object({ text: Type.String({ description: "Text to fill into the element." }) }),
]);

export function registerBrowserAgentTools(pi: ExtensionAPI, transport: BrowserTransport): void {
	const audit = new ActionAudit();

	const sessionGranted = resolveSessionGrant();
	const policyOf = (ctx: { hasUI?: boolean } | undefined) => ({
		sessionGranted,
		grantedHosts: [] as string[],
		hasUI: ctx?.hasUI ?? false,
	});

	const confirmFn = (ctx: { hasUI?: boolean; ui?: { confirm: (t: string, m: string) => Promise<boolean> } }) =>
		ctx?.hasUI && ctx.ui ? (question: string) => ctx.ui!.confirm("Browser action", question) : undefined;

	pi.registerTool({
		name: "browser_connection_status",
		label: "Browser Connection",
		description: "Report the current Pi browser bridge connection state without making a network connection.",
		promptSnippet: "Check whether the Pi browser bridge is connected",
		parameters: EmptyParameters,
		executionMode: "sequential",

		async execute() {
			const connected = transport.state === "connected";
			const isLocalRelay = transport.kind === "local-relay";
			const result = connected
				? createSuccessResult(
					"The browser bridge is connected.",
					{ state: transport.state, transport: transport.kind, readyTimeoutMs: transport.readyTimeoutMs },
					"Use browser_discover_tools to inspect available browser capabilities.",
				)
				: isLocalRelay && transport.state === "warming"
					? createWarningResult(
						`Pi is listening and waiting for the Chrome extension to connect (ready wait: ${transport.readyTimeoutMs}ms).`,
						{ state: transport.state, transport: transport.kind, readyTimeoutMs: transport.readyTimeoutMs },
						"Make sure the Chrome extension is installed and enabled; other browser_* tools will wait up to readyTimeoutMs before failing.",
					)
					: isLocalRelay
						? createWarningResult(
							"Pi is listening for the Chrome extension, but no extension is connected yet (or the port failed with port_unavailable).",
							{ state: transport.state, transport: transport.kind, readyTimeoutMs: transport.readyTimeoutMs },
							"Install/enable the Chrome extension, then retry browser_connection_status.",
						)
						: createWarningResult(
							"The browser bridge is not connected.",
							{ state: transport.state, transport: transport.kind, readyTimeoutMs: transport.readyTimeoutMs },
							"Configure a controller-facing transport before requesting browser actions.",
						);

			return toPiToolResult(result);
		},
	});

	pi.registerTool({
		name: "browser_discover_tools",
		label: "Discover Browser Tools",
		description: "Discover browser capabilities through the configured controller transport. Does not execute a browser action.",
		promptSnippet: "Discover available browser capabilities",
		parameters: EmptyParameters,
		executionMode: "sequential",

		async execute(_toolCallId, _params, signal, onUpdate) {
			onUpdate?.({
				content: [{ type: "text", text: "Discovering browser capabilities..." }],
			});

			try {
				await transport.connect(signal);
				await transport.waitForReady(signal);
				const tools = await transport.discoverTools(signal);
				return toPiToolResult(
					createSuccessResult(
						`Discovered ${tools.length} browser tool(s).`,
						{ state: transport.state, transport: transport.kind, tools },
						"Use only tools whose schemas and permission policy are understood.",
					),
				);
			} catch (error) {
				throw toPiToolError(error);
			}
		},
	});

	pi.registerTool({
		name: "browser_tabs_list",
		label: "List Browser Tabs",
		description: "List browser tabs and identify the active tab through the configured browser transport.",
		promptSnippet: "List browser tabs",
		parameters: EmptyParameters,
		executionMode: "sequential",

		async execute(toolCallId, _params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Listing browser tabs..." }] });
			try {
				return toPiToolResult(
					await handleBrowserTabsList(transport, requestContext(toolCallId, ctx), {}, signal),
				);
			} catch (error) {
				throw toPiToolError(error);
			}
		},
	});

	pi.registerTool({
		name: "browser_page_text",
		label: "Read Page Text",
		description: "Read the title, URL and bounded body text of a browser tab. Results are truncated to maxChars.",
		promptSnippet: "Read the current page text",
		parameters: ReadParameters,
		executionMode: "sequential",

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Reading page text..." }] });
			try {
				return toPiToolResult(
					await handleBrowserPageText(transport, requestContext(toolCallId, ctx), params, signal),
				);
			} catch (error) {
				throw toPiToolError(error);
			}
		},
	});

	pi.registerTool({
		name: "browser_page_snapshot",
		label: "Page Snapshot",
		description: "Return an accessibility snapshot with snapshotId and element refs for the target tab.",
		promptSnippet: "Get the page accessibility snapshot",
		parameters: ReadParameters,
		executionMode: "sequential",

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Capturing page snapshot..." }] });
			try {
				return toPiToolResult(
					await handleBrowserPageSnapshot(transport, requestContext(toolCallId, ctx), params, signal),
				);
			} catch (error) {
				throw toPiToolError(error);
			}
		},
	});

	pi.registerTool({
		name: "browser_screenshot",
		label: "Tab Screenshot",
		description: "Request a screenshot of the target tab. Reports clearly when the transport lacks screenshot capability.",
		promptSnippet: "Take a tab screenshot",
		parameters: TabIdParameters,
		executionMode: "sequential",

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: "Requesting screenshot..." }] });
			try {
				return toPiToolResult(
					await handleBrowserScreenshot(transport, requestContext(toolCallId, ctx), params, signal),
				);
			} catch (error) {
				throw toPiToolError(error);
			}
		},
	});

	pi.registerTool({
		name: "browser_element_click",
		label: "Click Element",
		description: "Click an element by snapshot ref. Write action: requires confirmation or a grant; stale refs fail with stale_element_ref.",
		promptSnippet: "Click a page element by ref",
		parameters: ElementParameters,
		executionMode: "sequential",

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: `Clicking ${params.ref}...` }] });
			try {
				return toPiToolResult(
					await handleElementClick(
						transport,
						requestContext(toolCallId, ctx),
						params,
						policyOf(ctx),
						audit,
						signal,
						confirmFn(ctx),
					),
				);
			} catch (error) {
				throw toPiToolError(error);
			}
		},
	});

	pi.registerTool({
		name: "browser_element_fill",
		label: "Fill Element",
		description: "Fill text into an element by snapshot ref. Sensitive targets require confirmation; values are never logged in plain text.",
		promptSnippet: "Fill a form field by ref",
		parameters: FillParameters,
		executionMode: "sequential",

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: `Filling ${params.ref}...` }] });
			try {
				return toPiToolResult(
					await handleElementFill(
						transport,
						requestContext(toolCallId, ctx),
						params,
						policyOf(ctx),
						audit,
						signal,
						confirmFn(ctx),
					),
				);
			} catch (error) {
				throw toPiToolError(error);
			}
		},
	});

	pi.registerTool({
		name: "browser_element_scroll",
		label: "Scroll To Element",
		description: "Scroll an element into view by snapshot ref.",
		promptSnippet: "Scroll to a page element",
		parameters: ElementParameters,
		executionMode: "sequential",

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			onUpdate?.({ content: [{ type: "text", text: `Scrolling to ${params.ref}...` }] });
			try {
				return toPiToolResult(
					await handleElementScroll(
						transport,
						requestContext(toolCallId, ctx),
						params,
						policyOf(ctx),
						audit,
						signal,
						confirmFn(ctx),
					),
				);
			} catch (error) {
				throw toPiToolError(error);
			}
		},
	});

	pi.on("session_shutdown", async () => {
		await transport.close();
	});
}

export default function (pi: ExtensionAPI): void {
	let transport: BrowserTransport;
	try {
		const config = resolveTransportConfig();
		transport = createBrowserTransport(config);
	} catch (error) {
		// 配置非法：不阻断 Pi 启动，回退骨架并在 tool 结果里表现为 unconfigured
		const reason = error instanceof Error ? error.message : String(error);
		pi.notify?.(`pi-browser-agent 配置无效，回退为骨架模式：${reason}`, "warning");
		transport = new UnconfiguredBrowserTransport();
	}

	registerBrowserAgentTools(pi, transport);

	// 异步连接：不阻塞 Pi 启动；失败（端口被占等）仅反映到连接状态。
	void transport.connect().catch(() => {
		// swallow: browser_connection_status 会如实反映 state
	});
}

interface SessionContext {
	sessionId?: string;
}

function requestContext(toolCallId: string, ctx: SessionContext | undefined) {
	return createRequestContext({ requestId: toolCallId, sessionId: ctx?.sessionId ?? "unknown" });
}

function toPiToolResult(result: BrowserToolResult) {
	return {
		content: [{ type: "text" as const, text: formatResult(result) }],
		details: result,
	};
}

function toPiToolError(error: unknown): Error {
	const result = createErrorResult(error);
	const code = result.error?.code ?? "internal_error";
	const next = result.next ? ` Next: ${result.next}` : "";
	return new Error(`${code}: ${result.summary}${next}`);
}

function formatResult(result: BrowserToolResult): string {
	const lines = [`status: ${result.status}`, `summary: ${result.summary}`];
	if (result.error) {
		lines.push(`error: ${result.error.code} (retryable=${result.error.retryable})`);
	}
	if (result.next) lines.push(`next: ${result.next}`);
	if (result.evidence !== undefined) {
		lines.push(`evidence: ${JSON.stringify(result.evidence)}`);
	}
	return lines.join("\n");
}

export function isBrowserTransportError(error: unknown): error is BrowserTransportError {
	return error instanceof BrowserTransportError;
}
