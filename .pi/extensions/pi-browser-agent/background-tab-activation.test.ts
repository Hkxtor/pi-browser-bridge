import { describe, expect, it } from "bun:test";
import {
	handleTabsActivate,
	tabsActivateDefinition,
} from "../../../background-tab-activation.js";

interface FakeTab {
	id?: number;
	title?: string;
	url?: string;
	active?: boolean;
}

function parsePayload(result: { content: Array<{ type: string; text: string }> }) {
	return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

function fakeChrome(tab: FakeTab = { id: 42, title: "Docs", url: "https://example.com/docs", active: false }) {
	const calls: string[] = [];
	const chromeApi = {
		tabs: {
			async get(tabId: number) {
				calls.push(`get:${tabId}`);
				return { ...tab };
			},
			async update(tabId: number, update: { active: boolean }) {
				calls.push(`update:${tabId}:${String(update.active)}`);
				return { ...tab, id: tabId, active: update.active };
			},
		},
		windows: {
			async update() {
				calls.push("windows.update");
			},
		},
	};
	return { chromeApi, calls };
}

describe("tabs_activate definition", () => {
	it("exposes a strict integer tabId schema", () => {
		expect(tabsActivateDefinition.name).toBe("tabs_activate");
		expect(tabsActivateDefinition.inputSchema).toEqual({
			type: "object",
			properties: {
				tabId: {
					type: "integer",
					description: "The ID of the browser tab to activate.",
				},
			},
			required: ["tabId"],
			additionalProperties: false,
		});
	});
});

describe("handleTabsActivate", () => {
	it("gets and activates only the requested tab without focusing its window", async () => {
		const { chromeApi, calls } = fakeChrome();

		const result = await handleTabsActivate({ tabId: 42 }, chromeApi);

		expect(result.isError).toBeUndefined();
		expect(parsePayload(result)).toEqual({
			tabId: 42,
			title: "Docs",
			url: "https://example.com/docs",
			active: true,
		});
		expect(calls).toEqual(["get:42", "update:42:true"]);
		expect(calls).not.toContain("windows.update");
	});

	it("rejects missing, non-integer, and unrelated arguments", async () => {
		for (const args of [{}, { tabId: 1.5 }, { tabId: 42, unexpected: true }]) {
			const { chromeApi, calls } = fakeChrome();
			const result = await handleTabsActivate(args, chromeApi);
			expect(result.isError).toBe(true);
			expect(parsePayload(result)).toMatchObject({
				error: { code: "BAD_REQUEST" },
			});
			expect(calls).toEqual([]);
		}
	});

	it("does not report success unless Chrome confirms the tab is active", async () => {
		const { chromeApi } = fakeChrome();
		chromeApi.tabs.update = async (tabId: number) => ({
			id: tabId,
			title: "Docs",
			url: "https://example.com/docs",
			active: false,
		});

		const result = await handleTabsActivate({ tabId: 42 }, chromeApi);

		expect(result.isError).toBe(true);
		expect(parsePayload(result)).toMatchObject({
			error: { code: "INTERNAL_ERROR" },
		});
	});

	it("returns TAB_NOT_FOUND when the tab disappears before activation", async () => {
		const { chromeApi, calls } = fakeChrome();
		chromeApi.tabs.get = async (tabId: number) => {
			calls.push(`get:${tabId}`);
			throw new Error(`No tab with id: ${tabId}`);
		};

		const result = await handleTabsActivate({ tabId: 99 }, chromeApi);

		expect(result.isError).toBe(true);
		expect(parsePayload(result)).toMatchObject({
			error: { code: "TAB_NOT_FOUND" },
		});
		expect(calls).toEqual(["get:99"]);
	});
});
