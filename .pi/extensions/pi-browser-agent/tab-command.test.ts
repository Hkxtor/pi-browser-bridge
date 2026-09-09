import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	BrowserTransportError,
	createSuccessResult,
} from "./protocol";
import {
	createBrowserTabTargetState,
	formatBrowserTabOption,
	registerBrowserTabCommand,
	TAB_OPTION_MAX_LENGTH,
} from "./tab-command";
import { MockBrowserTransport } from "./transport";

interface RegisteredCommand {
	description?: string;
	handler: (args: string, context: CommandContext) => Promise<void>;
}

interface CommandContext {
	mode: string;
	hasUI: boolean;
	waitForIdle: () => Promise<void>;
	ui: {
		select: (title: string, options: string[]) => Promise<string | undefined>;
		notify: (message: string, level?: "info" | "warning" | "error") => void;
	};
}

function activationEnvelope(tabId = 22) {
	return createSuccessResult("activated", {
		content: [{
			type: "text",
			text: JSON.stringify({
				tabId,
				title: "Selected",
				url: "https://selected.example/",
				active: true,
			}),
		}],
	});
}

function errorEnvelope(code: string, message: string) {
	return createSuccessResult("extension error", {
		content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
		isError: true,
	});
}

function commandTransport(options: {
	tabsText?: string;
	activateResult?: ReturnType<typeof createSuccessResult>;
} = {}) {
	return new MockBrowserTransport({
		tools: [
			{ name: "tabs_context", description: "tabs", inputSchema: {}, risk: "read" },
			{ name: "tabs_activate", description: "activate", inputSchema: {}, risk: "write" },
		],
		tabsContextText: options.tabsText ??
			'Open tabs (2):\n\n1. [11] "Current" [ACTIVE]\n   https://current.example/\n2. [22] "Selected"\n   https://selected.example/',
		tabActivateResult: options.activateResult ?? activationEnvelope(),
	});
}

function harness(select: (options: string[]) => string | undefined = (options) => options[1]) {
	let commandName = "";
	let command: RegisteredCommand | undefined;
	let llmCalls = 0;
	const notifications: Array<{ message: string; level?: string }> = [];
	const events: string[] = [];
	const pi = {
		registerCommand(name: string, definition: RegisteredCommand) {
			commandName = name;
			command = definition;
		},
		sendUserMessage() {
			llmCalls++;
		},
	} as unknown as ExtensionAPI;
	const context: CommandContext = {
		mode: "tui",
		hasUI: true,
		async waitForIdle() {
			events.push("waitForIdle");
		},
		ui: {
			async select(_title, options) {
				events.push("select");
				return select(options);
			},
			notify(message, level) {
				notifications.push({ message, level });
			},
		},
	};
	return {
		pi,
		context,
		events,
		notifications,
		get commandName() { return commandName; },
		get command() {
			if (!command) throw new Error("command was not registered");
			return command;
		},
		get llmCalls() { return llmCalls; },
	};
}

describe("browser tab target state", () => {
	it("stores and clears only the current session target", () => {
		const state = createBrowserTabTargetState();
		expect(state.get()).toBeUndefined();
		state.set(42);
		expect(state.get()).toBe(42);
		state.clear();
		expect(state.get()).toBeUndefined();
	});
});

describe("tab option formatting", () => {
	it("sanitizes control characters, preserves markers, and stays bounded", () => {
		const option = formatBrowserTabOption({
			tabId: 42,
			title: `Danger\u001b[31m\n${"x".repeat(300)}`,
			url: "https://example.com/path\u0007",
			active: true,
		}, 42);

		expect(option).toContain("[ACTIVE]");
		expect(option).toContain("[TARGET]");
		expect(option).toContain("[42]");
		expect(option).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
		expect(option.length).toBeLessThanOrEqual(TAB_OPTION_MAX_LENGTH);
	});

	it("keeps duplicate labels uniquely mapped by tabId", () => {
		const first = formatBrowserTabOption({ tabId: 1, title: "Same", url: "https://same.example", active: false });
		const second = formatBrowserTabOption({ tabId: 2, title: "Same", url: "https://same.example", active: false });
		expect(first).not.toBe(second);
	});
});

describe("/tab command", () => {
	it("registers without invoking the agent and commits the target only after activation", async () => {
		const transport = commandTransport();
		const target = createBrowserTabTargetState();
		target.set(11);
		const h = harness();
		registerBrowserTabCommand(h.pi, transport, target);

		expect(h.commandName).toBe("tab");
		expect(h.command.description).toMatch(/tab/i);
		await h.command.handler("", h.context);

		expect(h.events).toEqual(["waitForIdle", "select"]);
		expect(transport.invocations.map((call) => call.toolName)).toEqual([
			"tabs_context",
			"tabs_activate",
		]);
		expect(target.get()).toBe(22);
		expect(h.notifications.at(-1)?.message).toContain("22");
		expect(h.llmCalls).toBe(0);
	});

	it("marks the activated tab as both ACTIVE and TARGET on the next invocation", async () => {
		const transport = commandTransport();
		const target = createBrowserTabTargetState();
		const seenOptions: string[][] = [];
		const h = harness((options) => {
			seenOptions.push(options);
			return options.find((option) => option.includes("[22]"));
		});
		registerBrowserTabCommand(h.pi, transport, target);

		await h.command.handler("", h.context);
		transport.options.tabsContextText =
			'Open tabs (2):\n\n1. [11] "Current"\n   https://current.example/\n2. [22] "Selected" [ACTIVE]\n   https://selected.example/';
		await h.command.handler("", h.context);

		expect(seenOptions).toHaveLength(2);
		const selectedOnSecondRun = seenOptions[1].find((option) => option.includes("[22]"));
		expect(selectedOnSecondRun).toContain("[ACTIVE]");
		expect(selectedOnSecondRun).toContain("[TARGET]");
		expect(target.get()).toBe(22);
		expect(h.llmCalls).toBe(0);
	});

	it("shows one warming notice before waiting for the extension", async () => {
		const transport = commandTransport();
		(transport as unknown as { currentState: "warming" }).currentState = "warming";
		const target = createBrowserTabTargetState();
		const h = harness();
		registerBrowserTabCommand(h.pi, transport, target);

		await h.command.handler("", h.context);

		const warmingNotices = h.notifications.filter((entry) => /Waiting for the Chrome extension/i.test(entry.message));
		expect(warmingNotices).toHaveLength(1);
		expect(transport.waitForReadyCalls).toBe(2);
		expect(target.get()).toBe(22);
	});

	it("shows usage for arguments and does not contact the browser", async () => {
		const transport = commandTransport();
		const target = createBrowserTabTargetState();
		const h = harness();
		registerBrowserTabCommand(h.pi, transport, target);

		await h.command.handler("22", h.context);

		expect(h.events).toEqual(["waitForIdle"]);
		expect(transport.invocations).toHaveLength(0);
		expect(h.notifications.at(-1)?.message).toContain("Usage: /tab");
	});

	it("reports the non-interactive boundary without contacting the browser", async () => {
		const transport = commandTransport();
		const target = createBrowserTabTargetState();
		const h = harness();
		h.context.hasUI = false;
		h.context.mode = "print";
		registerBrowserTabCommand(h.pi, transport, target);

		await h.command.handler("", h.context);

		expect(transport.invocations).toHaveLength(0);
		expect(h.notifications.at(-1)?.message).toMatch(/interactive|UI/i);
	});

	it("does not open a selector or change state when no tabs are available", async () => {
		const transport = commandTransport({ tabsText: "Open tabs (0):\n\n" });
		const target = createBrowserTabTargetState();
		target.set(11);
		const h = harness();
		registerBrowserTabCommand(h.pi, transport, target);

		await h.command.handler("", h.context);

		expect(h.events).toEqual(["waitForIdle"]);
		expect(target.get()).toBe(11);
		expect(h.notifications.at(-1)?.message).toMatch(/No browser tabs/i);
	});

	it("treats Escape as cancellation without activating or changing state", async () => {
		const transport = commandTransport();
		const target = createBrowserTabTargetState();
		target.set(11);
		const h = harness(() => undefined);
		registerBrowserTabCommand(h.pi, transport, target);

		await h.command.handler("", h.context);

		expect(transport.invocations.map((call) => call.toolName)).toEqual(["tabs_context"]);
		expect(target.get()).toBe(11);
	});

	it("keeps the old target when the selected tab closes", async () => {
		const transport = commandTransport({
			activateResult: errorEnvelope("TAB_NOT_FOUND", "The selected tab was closed."),
		});
		const target = createBrowserTabTargetState();
		target.set(11);
		const h = harness();
		registerBrowserTabCommand(h.pi, transport, target);

		await h.command.handler("", h.context);

		expect(target.get()).toBe(11);
		expect(h.notifications.at(-1)).toMatchObject({ level: "error" });
		expect(h.notifications.at(-1)?.message).toContain("tab_not_found");
	});

	it("maps unsupported extension capability and preserves the old target", async () => {
		const transport = commandTransport();
		transport.failures.tabs_activate = new Error("Unknown tool: tabs_activate") as BrowserTransportError;
		const target = createBrowserTabTargetState();
		target.set(11);
		const h = harness();
		registerBrowserTabCommand(h.pi, transport, target);

		await h.command.handler("", h.context);

		expect(target.get()).toBe(11);
		expect(h.notifications.at(-1)?.message).toContain("tool_not_found");
		expect(h.notifications.at(-1)?.message).toMatch(/reload|update/i);
	});

	it("surfaces ready timeout and preserves the old target", async () => {
		const transport = commandTransport();
		transport.waitForReady = async () => {
			throw new BrowserTransportError("browser_not_ready", "Timed out waiting for Chrome.", true);
		};
		const target = createBrowserTabTargetState();
		target.set(11);
		const h = harness();
		registerBrowserTabCommand(h.pi, transport, target);

		await h.command.handler("", h.context);

		expect(target.get()).toBe(11);
		expect(h.notifications.at(-1)?.message).toContain("browser_not_ready");
	});
});
