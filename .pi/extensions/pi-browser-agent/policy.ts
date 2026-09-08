export type WriteActionKind = "click" | "fill" | "scroll";

export type PermissionDecision = "allow" | "deny" | "require_confirm";

export interface WriteActionRequest {
	kind: WriteActionKind;
	snapshotId: string;
	ref: string;
	tabId?: number;
	url?: string;
	targetName?: string;
	value?: string;
}

export interface PermissionContext {
	sessionGranted: boolean;
	grantedHosts: readonly string[];
	hasUI: boolean;
}

const SENSITIVE_PATTERN = /\b(password|passwd|secret|token|api[-_ ]?key|authorization|cookie|credential)\b/i;

export function isSensitiveTarget(targetName?: string, value?: string): boolean {
	if (targetName && SENSITIVE_PATTERN.test(targetName)) return true;
	if (value && SENSITIVE_PATTERN.test(value)) return true;
	return false;
}

export function redactValue(value: string): string {
	void value;
	return `<redacted>`;
}

export function decideWritePermission(
	action: WriteActionRequest,
	context: PermissionContext,
): PermissionDecision {
	if (isSensitiveTarget(action.targetName, action.value)) {
		return context.hasUI ? "require_confirm" : "deny";
	}

	if (context.sessionGranted) return "allow";

	const host = hostOf(action.url);
	if (host && context.grantedHosts.includes(host)) return "allow";

	return context.hasUI ? "require_confirm" : "deny";
}

function hostOf(url?: string): string | null {
	if (!url) return null;
	try {
		return new URL(url).hostname;
	} catch {
		return null;
	}
}
