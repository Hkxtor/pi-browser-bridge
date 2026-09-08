import { BrowserTransportError } from "./protocol";

/**
 * 旧版协议兼容 envelope 层。只做纯解析/编码/映射，无网络、无副作用。
 * 参考当前 background.js 的 tools/discover、tools/invoke、tools/progress 语义。
 */

export type LegacyEnvelopeRequest =
	| { kind: "ping" }
	| { kind: "discover"; id: number }
	| { kind: "invoke"; id: number; tool: string; arguments: Record<string, unknown> };

export function parseLegacyEnvelope(message: unknown): LegacyEnvelopeRequest | null {
	if (typeof message !== "object" || message === null) return null;
	const m = message as Record<string, unknown>;
	const method = m.method;
	if (method === "ping") return { kind: "ping" };

	if (method === "tools/discover") {
		const id = m.id;
		return typeof id === "number" ? { kind: "discover", id } : null;
	}

	if (method === "tools/invoke") {
		const id = m.id;
		if (typeof id !== "number") return null;
		const params = (m.params ?? {}) as Record<string, unknown>;
		const tool = params.tool;
		if (typeof tool !== "string" || tool.length === 0) return null;
		const args = params.arguments;
		return {
			kind: "invoke",
			id,
			tool,
			arguments:
				typeof args === "object" && args !== null && !Array.isArray(args)
					? (args as Record<string, unknown>)
					: {},
		};
	}

	return null;
}

const ERROR_CODE_MAP: Record<string, string> = {
	QUEUE_FULL: "queue_full",
	QUEUE_TIMEOUT: "queue_timeout",
	COMMAND_TIMEOUT: "command_timeout",
	EXECUTION_TIMEOUT: "execution_timeout",
	SCREENSHOT_TIMEOUT: "screenshot_timeout",
	CDP_ATTACH_FAILED: "cdp_attach_failed",
	CAPABILITY_NOT_SUPPORTED: "capability_not_supported",
	CLIENT_NOT_ACTIVE: "client_not_active",
	CLIENT_NOT_CONNECTED: "client_not_connected",
	TAB_NOT_FOUND: "tab_not_found",
	URL_BLOCKED: "url_blocked",
	TIMEOUT: "timeout",
	INTERNAL_ERROR: "internal_error",
	STALE_SCREENSHOT_RESULT: "stale_result",
	EXECUTION_ERROR: "execution_error",
	BAD_REQUEST: "invalid_arguments",
};

const RETRYABLE_CODES = new Set([
	"queue_full",
	"queue_timeout",
	"command_timeout",
	"timeout",
	"client_not_connected",
]);

export function mapLegacyErrorCode(code: string | undefined): string {
	if (!code) return "internal_error";
	return ERROR_CODE_MAP[code] ?? "internal_error";
}

export function legacyErrorToTransportError(input: {
	code?: string;
	message?: string;
}): BrowserTransportError {
	const code = mapLegacyErrorCode(input.code);
	return new BrowserTransportError(
		code,
		input.message ?? "Unknown legacy relay error.",
		RETRYABLE_CODES.has(code),
	);
}

export function encodeDiscoverResult(
	id: number,
	tools: readonly Record<string, unknown>[],
): { id: number; result: { tools: typeof tools } } {
	return { id, result: { tools } };
}

export function encodeInvokeResult(
	id: number,
	result?: unknown,
	error?: { code: string; message: string },
): { id: number; result?: unknown; error?: { code: string; message: string } } {
	if (error) return { id, error };
	return { id, result };
}
