import type { ActionAudit } from "./audit";
import { legacyErrorToTransportError } from "./legacy-envelope";
import {
	decideWritePermission,
	isSensitiveTarget,
} from "./policy";
import type { PermissionContext, WriteActionKind } from "./policy";
import {
	BrowserRequestContext,
	BrowserTab,
	BrowserToolResult,
	BrowserTransportError,
	createSuccessResult,
	createWarningResult,
	truncateText,
} from "./protocol";
import type { BrowserTransport } from "./transport";

/**
 * Pi 侧工具 handler：全部走真实浏览器扩展的工具集。
 * 工具 schema 以 M3 联测捕获的真实返回为权威来源（捕获物已清理，schema 固化在本文件中）。
 *
 * 扩展返回均为 MCP-style：{ content: [{ type: "text", text: string }] }
 * —— 值是 JSON 编码后的文本，按字段解析文本。
 */

export const DEFAULT_TEXT_LIMIT = 50_000;

export interface TabScopedParams {
	tabId?: number;
	maxChars?: number;
}

// ---------- 文本响应解析 ---------------------------------

function mcpText(evidence: unknown): string {
	const content = (evidence as { content?: { text?: unknown }[] } | undefined)?.content;
	if (Array.isArray(content) && content.length > 0 && typeof content[0]?.text === "string") {
		return content[0].text;
	}
	const direct = (evidence as { text?: unknown } | undefined)?.text;
	if (typeof direct === "string") return direct;
	return JSON.stringify(evidence ?? "");
}

/** tabs_context 返回文本："Open tabs (N):\n\n1. [280923130] \"Example Domain\" [ACTIVE]\n   https://example.com/" */
function parseTabsContextText(textValue: string): BrowserTab[] {
	const tabs: BrowserTab[] = [];
	const pattern = /^\d+\.\s+\[(\d+)\]\s+"([\s\S]*?)"([ \t]+\[ACTIVE\])?(?:[ \t]+\(loading\))?\r?\n[ \t]+([^\r\n]*)/gm;
	for (const match of textValue.matchAll(pattern)) {
		tabs.push({
			tabId: Number(match[1]),
			title: match[2],
			url: match[4],
			active: match[3] !== undefined,
		});
	}
	return tabs;
}

/** get_page_text 返回 "Title: X\nURL: Y\nSource: Z\n\n<text>" 形状 */
function parsePageText(textValue: string): { title: string; url: string; body: string } {
	const titleMatch = /^Title: (.+)$/m.exec(textValue);
	const urlMatch = /^URL: (\S+)$/m.exec(textValue);
	const body = textValue.replace(/^Title: .+\nURL: .+\nSource: .+\n\n?/s, "");
	return {
		title: titleMatch?.[1] ?? "",
		url: urlMatch?.[1] ?? "",
		body,
	};
}

/** read_page 返回带 ref 的 tree —— 提取 [ref_N] 与 role/name */
function parseReadPageRefs(textValue: string): { ref: string; role: string; name: string }[] {
	const out: { ref: string; role: string; name: string }[] = [];
	const re = /\[ref_(\d+)\]\s+(\S+)\s+"([^"]*)"/g;
	for (const m of textValue.matchAll(re)) {
		// 保留完整 "ref_N" 前缀（真实扩展按此描述）
		out.push({ ref: `ref_${m[1]}`, role: m[2], name: m[3] });
	}
	return out;
}

// ---------- 只读工具 -------------------------------------

export async function handleBrowserTabsList(
	transport: BrowserTransport,
	context: BrowserRequestContext,
	_params: { tabId?: number } = {},
	signal?: AbortSignal,
): Promise<BrowserToolResult> {
	const result = await invokeTransport(transport, "tabs_context", {}, context, signal);
	const tabs = parseTabsContextText(mcpText(result.evidence));
	const active = tabs.find((tab) => tab.active);

	return createSuccessResult(
		active
			? `${tabs.length} browser tab(s). Active: "${active.title}" (${active.url}).`
			: `${tabs.length} browser tab(s). No active tab reported.`,
		{ tabs },
		"Use browser_page_text or browser_page_snapshot to read a tab.",
	);
}

export async function handleBrowserTabActivate(
	transport: BrowserTransport,
	context: BrowserRequestContext,
	tabId: number,
	signal?: AbortSignal,
): Promise<BrowserToolResult> {
	try {
		const result = await invokeTransport(transport, "tabs_activate", { tabId }, context, signal);
		const envelope = result.evidence as { isError?: unknown } | undefined;
		const text = mcpText(result.evidence);
		const payload = parseJsonObject(text);

		if (envelope?.isError === true) {
			const error = payload?.error as { code?: unknown; message?: unknown } | undefined;
			throw legacyErrorToTransportError({
				code: typeof error?.code === "string" ? error.code : undefined,
				message: typeof error?.message === "string" ? error.message : text,
			});
		}

		if (
			!payload
			|| !Number.isInteger(payload.tabId)
			|| typeof payload.title !== "string"
			|| typeof payload.url !== "string"
			|| payload.active !== true
		) {
			throw new BrowserTransportError(
				"invalid_transport_result",
				"tabs_activate returned an invalid tab payload.",
				true,
				result.evidence,
			);
		}

		const tab: BrowserTab = {
			tabId: payload.tabId as number,
			title: payload.title,
			url: payload.url,
			active: true,
		};
		return createSuccessResult(`Activated browser tab ${tab.tabId}.`, tab);
	} catch (error) {
		throw mapExtensionError(error);
	}
}

export async function handleBrowserPageText(
	transport: BrowserTransport,
	context: BrowserRequestContext,
	params: TabScopedParams = {},
	signal?: AbortSignal,
): Promise<BrowserToolResult> {
	// 真实扩展只支持 max_chars（下划线命名）
	const tabId = resolveTabId(params, context);
	const args = { tabId: tabId ?? -1 };
	try {
		const result = await invokeTransport(transport, "get_page_text", args, context, signal);
		const text = mcpText(result.evidence);
		const parsed = parsePageText(text);
		const truncated = truncateText(parsed.body, params.maxChars ?? DEFAULT_TEXT_LIMIT);

		return createSuccessResult(
			truncated.truncated
				? `Page text from "${parsed.title}" truncated to ${params.maxChars ?? DEFAULT_TEXT_LIMIT} of ${truncated.originalLength} characters.`
				: `Page text from "${parsed.title}" (${truncated.originalLength} characters).`,
			{
				title: parsed.title,
				url: parsed.url,
				text: truncated.text,
				truncated: truncated.truncated,
				originalLength: truncated.originalLength,
			},
			truncated.truncated ? "Ask the extension with read_page for structured chunks." : undefined,
		);
	} catch (error) {
		throw mapExtensionError(error);
	}
}

export async function handleBrowserPageSnapshot(
	transport: BrowserTransport,
	context: BrowserRequestContext,
	params: TabScopedParams = {},
	signal?: AbortSignal,
): Promise<BrowserToolResult> {
	const tabId = resolveTabId(params, context);
	const args = { tabId: tabId ?? -1 };
	try {
		const result = await invokeTransport(transport, "read_page", args, context, signal);
		const text = mcpText(result.evidence);
		const refs = parseReadPageRefs(text);
		const truncated = truncateText(text, params.maxChars ?? DEFAULT_TEXT_LIMIT);

		return createSuccessResult(
			`Page read_page snapshot with ${refs.length} element(s).${truncated.truncated ? " (truncated)" : ""}`,
			{
				snapshotId: `live-${Date.now()}`,
				text: truncated.text,
				elements: refs,
				truncated: truncated.truncated,
			},
			"Provide tabId explicitly if needed; ref ids are live (~still) until the page changes.",
		);
	} catch (error) {
		throw mapExtensionError(error);
	}
}

export async function handleBrowserScreenshot(
	transport: BrowserTransport,
	context: BrowserRequestContext,
	params: { tabId?: number } = {},
	signal?: AbortSignal,
): Promise<BrowserToolResult> {
	const tabId = resolveTabId(params, context);
	const args = tabId !== undefined ? { action: "screenshot", tabId } : { action: "screenshot" };
	try {
		const result = await invokeTransport(transport, "computer", args, context, signal);
		const text = mcpText(result.evidence);
		const isBase64 = /^[A-Za-z0-9+/=\r\n]{100,}$/.test(text.trim().replace(/^data:[^;]+;base64,/, ""));
		return createSuccessResult(
			"Screenshot captured by the real extension.",
			{ available: true, mimeType: undefined, rawTextPreview: text.slice(0, 200), isBase64 },
		);
	} catch (error) {
		const mapped = mapExtensionError(error);
		if (mapped.code === "tab_not_found") throw mapped;
		throw new BrowserTransportError(
			"screenshot_unavailable",
			`Screenshot failed or is unavailable on this extension: ${mapped.message}`,
			true,
			mapped.details,
		);
	}
}

// ---------- 写操作工具 ---------------------------------------

export interface ElementActionParams {
	snapshotId: string;
	ref: string;
	tabId?: number;
	url?: string;
	targetName?: string;
	text?: string;
}

export type ConfirmFn = (question: string) => Promise<boolean>;

export function handleElementClick(
	transport: BrowserTransport,
	context: BrowserRequestContext,
	params: ElementActionParams,
	policy: PermissionContext,
	audit: ActionAudit,
	signal?: AbortSignal,
	confirmFn?: ConfirmFn,
): Promise<BrowserToolResult> {
	return runWrite(transport, context, "click", params, policy, audit, signal, confirmFn);
}

export function handleElementFill(
	transport: BrowserTransport,
	context: BrowserRequestContext,
	params: ElementActionParams,
	policy: PermissionContext,
	audit: ActionAudit,
	signal?: AbortSignal,
	confirmFn?: ConfirmFn,
): Promise<BrowserToolResult> {
	return runWrite(transport, context, "fill", params, policy, audit, signal, confirmFn);
}

export function handleElementScroll(
	transport: BrowserTransport,
	context: BrowserRequestContext,
	params: ElementActionParams,
	policy: PermissionContext,
	audit: ActionAudit,
	signal?: AbortSignal,
	confirmFn?: ConfirmFn,
): Promise<BrowserToolResult> {
	return runWrite(transport, context, "scroll", params, policy, audit, signal, confirmFn);
}

async function runWrite(
	transport: BrowserTransport,
	context: BrowserRequestContext,
	kind: WriteActionKind,
	params: ElementActionParams,
	policy: PermissionContext,
	audit: ActionAudit,
	signal?: AbortSignal,
	confirmFn?: ConfirmFn,
): Promise<BrowserToolResult> {
	const effectiveParams = { ...params, tabId: resolveTabId(params, context) };
	const action = {
		kind,
		snapshotId: effectiveParams.snapshotId,
		ref: effectiveParams.ref,
		tabId: effectiveParams.tabId,
		url: effectiveParams.url,
		targetName: effectiveParams.targetName,
		value: effectiveParams.text,
	};
	const decision = decideWritePermission(action, policy);
	if (decision === "deny") {
		audit.record(auditEntry(kind, effectiveParams, "deny", "permission_denied"));
		throw new BrowserTransportError(
			"permission_denied",
			`Write action "${kind}" is not permitted without a grant or UI confirmation.`,
			false,
		);
	}
	if (decision === "require_confirm") {
		const approved = confirmFn ? await confirmFn(confirmQuestion(kind, effectiveParams)) : false;
		if (!approved) {
			audit.record(auditEntry(kind, effectiveParams, "require_confirm", "permission_denied"));
			throw new BrowserTransportError(
				"permission_denied",
				`Write action "${kind}" was not confirmed.`,
				false,
			);
		}
	}

	try {
		await transport.connect(signal);
		// 权限已通过（R7），此处才可等待扩展就绪；调用只发送一次（R8）
		await transport.waitForReady(signal);
		let toolName: string;
		let args: Record<string, unknown>;
		// snapshotId 归 Pi 内部调用记录用，不要放进 computer/form_input 的 arguments 里
		// （真实扩展会报 "snapshotId is not supported" —— M2 发现，我们在开始修）
		const base: Record<string, unknown> = { tabId: effectiveParams.tabId };
		if (kind === "click") {
			// 真实 computer 无 "click"；用 left_click + ref（符合扩展文档: ref 是 coordinate 的替代）
			toolName = "computer";
			if (effectiveParams.ref) {
				args = { ...base, action: "left_click", ref: effectiveParams.ref };
			} else {
				args = { ...base, action: "left_click" };
			}
		} else if (kind === "fill") {
			toolName = "form_input";
			args = { ...base, ref: effectiveParams.ref, value: effectiveParams.text };
		} else {
			toolName = "computer";
			args = { ...base, action: "scroll_to", ref: effectiveParams.ref };
		}
		const result = await transport.invoke(toolName, args, context, signal);
		audit.record(auditEntry(kind, effectiveParams, "allow", "success"));
		return createSuccessResult(
			`${kind} on ${effectiveParams.ref} succeeded.`,
			{ action: kind, ref: effectiveParams.ref, snapshotId: effectiveParams.snapshotId, transport: result.evidence },
			"Element refs expire on page change; refresh via read_page if the page changed.",
		);
	} catch (error) {
		const code = error instanceof BrowserTransportError ? error.code : "internal_error";
		audit.record(auditEntry(kind, effectiveParams, "allow", code));
		throw mapExtensionError(error);
	}
}

function auditEntry(
	kind: WriteActionKind,
	params: ElementActionParams,
	decision: "allow" | "deny" | "require_confirm",
	result: string,
) {
	const sensitive = isSensitiveTarget(params.targetName, params.text);
	return {
		action: kind,
		ref: params.ref,
		snapshotId: params.snapshotId,
		tabId: params.tabId,
		decision,
		result,
		valueLength: params.text?.length,
		redacted: sensitive || undefined,
	};
}

function resolveTabId(
	params: { tabId?: number },
	context: BrowserRequestContext,
): number | undefined {
	return params.tabId ?? context.tabId;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(text);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: null;
	} catch {
		return null;
	}
}

function confirmQuestion(kind: WriteActionKind, params: ElementActionParams): string {
	const target = params.targetName ?? params.ref;
	if (kind === "fill") {
		return `Allow fill of "${target}" (value length ${params.text?.length ?? 0})?`;
	}
	return `Allow ${kind} on "${target}"?`;
}

// ---------- 错误码映射 ----------------------------------------------

/** 真实扩展会以字符串错误回传一些情况 —— 映射为内部稳定码 */
function mapExtensionError(error: unknown): BrowserTransportError {
	const message = error instanceof Error ? error.message : String(error);
	const details = error instanceof BrowserTransportError ? error.details : undefined;

	if (/Unknown tool/i.test(message)) {
		return new BrowserTransportError("tool_not_found", message, false, details);
	}
	if (/Invalid arguments/i.test(message)) {
		return new BrowserTransportError("invalid_arguments", message, false, details);
	}
	return error instanceof BrowserTransportError
		? error
		: new BrowserTransportError("internal_error", message, false, details);
}

// ---------- transport invoke helper --------------------------------

async function invokeTransport(
	transport: BrowserTransport,
	tool: string,
	arguments_: unknown,
	context: BrowserRequestContext,
	signal?: AbortSignal,
): Promise<BrowserToolResult> {
	await transport.connect(signal);
	// 冷启动有界等待（R3）：扩展未连接时在 readyTimeoutMs 窗口内等待
	await transport.waitForReady(signal);
	const raw = await transport.invoke(tool, arguments_, context, signal);
	let evidence = raw.evidence;
	let summary = raw.summary;

	try {
		// 真实 LocalRelayTransport 返回的 evidence 形状：直接就是 {content:[...]}。
		// 兼容通用 BrowserToolResult
		if (evidence && typeof evidence === "object") {
			// 不动
		} else if (typeof evidence === "string") {
			summary = evidence;
		}
	} catch {
		/* noop */
	}
	void evidence;
	void summary;

	return raw;
}
