import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	BrowserTransportError,
	createErrorResult,
} from "./protocol";
import type { BrowserTab } from "./protocol";
import {
	handleBrowserTabActivate,
	handleBrowserTabsList,
} from "./tools";
import type { BrowserTransport } from "./transport";

export const TAB_OPTION_MAX_LENGTH = 160;

export interface BrowserTabTargetState {
	get(): number | undefined;
	set(tabId: number): void;
	clear(): void;
}

export function createBrowserTabTargetState(): BrowserTabTargetState {
	let tabId: number | undefined;
	return {
		get: () => tabId,
		set: (nextTabId) => {
			tabId = nextTabId;
		},
		clear: () => {
			tabId = undefined;
		},
	};
}

export function formatBrowserTabOption(tab: BrowserTab, targetTabId?: number): string {
	const markers = [
		tab.active ? "[ACTIVE]" : undefined,
		tab.tabId === targetTabId ? "[TARGET]" : undefined,
	].filter((marker): marker is string => marker !== undefined);
	const prefix = `${markers.length > 0 ? `${markers.join(" ")} ` : ""}[${tab.tabId}] `;
	const title = sanitizeDisplayText(tab.title) || "Untitled";
	const url = sanitizeDisplayText(tab.url) || "no URL";
	const details = `${title} — ${url}`;
	const available = Math.max(0, TAB_OPTION_MAX_LENGTH - prefix.length);
	const bounded = details.length > available
		? `${details.slice(0, Math.max(0, available - 1))}…`
		: details;
	return `${prefix}${bounded}`;
}

export function registerBrowserTabCommand(
	pi: ExtensionAPI,
	transport: BrowserTransport,
	targetState: BrowserTabTargetState,
): void {
	pi.registerCommand("tab", {
		description: "Select the browser tab used by default for browser tools",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			if (args.trim().length > 0) {
				ctx.ui.notify("Usage: /tab", "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("The /tab selector requires an interactive UI.", "warning");
				return;
			}
			if (transport.state === "warming") {
				ctx.ui.notify("Waiting for the Chrome extension to connect…", "info");
			}

			try {
				const listResult = await handleBrowserTabsList(
					transport,
					commandRequestContext(ctx, targetState.get()),
				);
				const tabs = extractTabs(listResult.evidence);
				if (tabs.length === 0) {
					ctx.ui.notify("No browser tabs are available.", "warning");
					return;
				}

				const byOption = new Map<string, BrowserTab>();
				for (const tab of tabs) {
					byOption.set(formatBrowserTabOption(tab, targetState.get()), tab);
				}
				const selected = await ctx.ui.select("Select browser tab", [...byOption.keys()]);
				if (selected === undefined) return;

				const tab = byOption.get(selected);
				if (!tab) {
					throw new BrowserTransportError(
						"invalid_selection",
						"The selected browser tab is no longer available in the chooser.",
						false,
					);
				}

				const activated = await handleBrowserTabActivate(
					transport,
					commandRequestContext(ctx, targetState.get()),
					tab.tabId,
				);
				const activatedTab = activated.evidence as BrowserTab | undefined;
				if (activatedTab?.tabId !== tab.tabId || activatedTab.active !== true) {
					throw new BrowserTransportError(
						"invalid_transport_result",
						"The browser extension activated a different tab than the one selected.",
						true,
						activated.evidence,
					);
				}

				targetState.set(tab.tabId);
				ctx.ui.notify(
					`Browser tab [${tab.tabId}] is now the Pi default target: ${sanitizeDisplayText(activatedTab.title) || "Untitled"}`,
					"info",
				);
			} catch (error) {
				notifyCommandError(ctx, error);
			}
		},
	});
}

function sanitizeDisplayText(value: string): string {
	return value
		.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function extractTabs(evidence: unknown): BrowserTab[] {
	const tabs = (evidence as { tabs?: unknown } | undefined)?.tabs;
	if (!Array.isArray(tabs)) {
		throw new BrowserTransportError(
			"invalid_transport_result",
			"tabs_context did not return a tabs array.",
			true,
			evidence,
		);
	}
	return tabs.filter(isBrowserTab);
}

function isBrowserTab(value: unknown): value is BrowserTab {
	if (!value || typeof value !== "object") return false;
	const tab = value as Partial<BrowserTab>;
	return Number.isInteger(tab.tabId)
		&& typeof tab.title === "string"
		&& typeof tab.url === "string"
		&& typeof tab.active === "boolean";
}

function commandRequestContext(ctx: ExtensionCommandContext, tabId?: number) {
	const sessionId = (ctx as ExtensionCommandContext & { sessionId?: string }).sessionId;
	return {
		requestId: `tab-command-${Date.now()}`,
		sessionId: sessionId ?? "unknown",
		tabId,
	};
}

function notifyCommandError(ctx: ExtensionCommandContext, error: unknown): void {
	const result = createErrorResult(error);
	const code = result.error?.code ?? "internal_error";
	const next = commandRecoveryAdvice(code, result.next);
	ctx.ui.notify(`${code}: ${result.summary}${next ? ` Next: ${next}` : ""}`, "error");
}

function commandRecoveryAdvice(code: string, fallback?: string): string | undefined {
	if (code === "tool_not_found") {
		return "Update or reload the Chrome extension, then retry /tab.";
	}
	if (code === "tab_not_found") {
		return "Run /tab again and choose a tab that is still open.";
	}
	if (["browser_not_ready", "client_not_connected"].includes(code)) {
		return "Start or reload the Chrome extension, then retry /tab.";
	}
	return fallback;
}
