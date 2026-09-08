export type BrowserTransportState = "disconnected" | "warming" | "connected" | "closed";

export type BrowserRisk = "read" | "write" | "high";

export interface BrowserToolDefinition {
	name: string;
	description: string;
	inputSchema: unknown;
	risk: BrowserRisk;
}

export interface BrowserRequestContext {
	requestId: string;
	sessionId: string;
	tabId?: number;
}

export interface BrowserResultError {
	code: string;
	retryable: boolean;
}

export interface BrowserToolResult {
	status: "success" | "warning" | "error";
	summary: string;
	evidence?: unknown;
	next?: string;
	error?: BrowserResultError;
}

export interface BrowserTab {
	tabId: number;
	title: string;
	url: string;
	active: boolean;
}

export interface BrowserPageText {
	title: string;
	url: string;
	text: string;
	source?: string;
}

export interface BrowserElementRef {
	ref: string;
	role: string;
	name?: string;
}

export interface BrowserPageSnapshot {
	snapshotId: string;
	title: string;
	url: string;
	elements: BrowserElementRef[];
}

export interface BrowserScreenshot {
	available: boolean;
	mimeType?: string;
	dataBase64?: string;
	note?: string;
}

export interface TruncatedText {
	text: string;
	truncated: boolean;
	originalLength: number;
}

export function truncateText(text: string, maxChars: number): TruncatedText {
	if (text.length <= maxChars) {
		return { text, truncated: false, originalLength: text.length };
	}
	return { text: text.slice(0, maxChars), truncated: true, originalLength: text.length };
}

export class BrowserTransportError extends Error {
	readonly code: string;
	readonly retryable: boolean;
	readonly details: unknown;

	constructor(code: string, message: string, retryable: boolean, details?: unknown) {
		super(message);
		this.name = "BrowserTransportError";
		this.code = code;
		this.retryable = retryable;
		this.details = details;
	}
}

export function createRequestContext(input: BrowserRequestContext): BrowserRequestContext {
	return { ...input };
}

export function createSuccessResult(summary: string, evidence?: unknown, next?: string): BrowserToolResult {
	return {
		status: "success",
		summary,
		evidence,
		next,
	};
}

export function createWarningResult(summary: string, evidence?: unknown, next?: string): BrowserToolResult {
	return {
		status: "warning",
		summary,
		evidence,
		next,
	};
}

export function createErrorResult(error: unknown): BrowserToolResult {
	const normalized = normalizeError(error);

	return {
		status: "error",
		summary: normalized.message,
		evidence: normalized.details,
		next: recoveryAdvice(normalized),
		error: {
			code: normalized.code,
			retryable: normalized.retryable,
		},
	};
}

export function normalizeError(error: unknown): {
	code: string;
	message: string;
	retryable: boolean;
	details: unknown;
} {
	if (error instanceof BrowserTransportError) {
		return {
			code: error.code,
			message: error.message,
			retryable: error.retryable,
			details: error.details,
		};
	}

	if (error instanceof Error) {
		return {
			code: "internal_error",
			message: error.message,
			retryable: false,
			details: undefined,
		};
	}

	return {
		code: "internal_error",
		message: "Unknown browser transport error.",
		retryable: false,
		details: undefined,
	};
}

function recoveryAdvice(error: { code: string; retryable: boolean }): string {
	if (error.code === "controller_transport_unconfigured") {
		return "Configure a controller transport before retrying.";
	}

	if (error.retryable) {
		return "Retry the operation after the browser connection is ready.";
	}

	return "Inspect the error and update the configuration before retrying.";
}
