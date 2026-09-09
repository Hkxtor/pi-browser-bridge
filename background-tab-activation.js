export const tabsActivateDefinition = Object.freeze({
	name: "tabs_activate",
	description: "Activate a browser tab in its current Chrome window.",
	inputSchema: {
		type: "object",
		properties: {
			tabId: {
				type: "integer",
				description: "The ID of the browser tab to activate.",
			},
		},
		required: ["tabId"],
		additionalProperties: false,
	},
});

/**
 * Activate a tab without changing the operating system's focused window.
 * The Chrome API is injected so this module stays testable outside Chrome.
 *
 * @param {unknown} args
 * @param {{ tabs: { get(tabId: number): Promise<object>, update(tabId: number, updateProperties: { active: boolean }): Promise<object | undefined> } }} [chromeApi]
 */
export async function handleTabsActivate(args, chromeApi = globalThis.chrome) {
	if (!isValidArguments(args)) {
		return errorResult("BAD_REQUEST", "tabs_activate requires exactly one integer tabId argument.");
	}

	const { tabId } = args;
	try {
		await chromeApi.tabs.get(tabId);
		const updated = await chromeApi.tabs.update(tabId, { active: true });
		const finalTab = updated ?? await chromeApi.tabs.get(tabId);
		if (!finalTab || finalTab.id !== tabId) {
			return errorResult("TAB_NOT_FOUND", `Tab ${tabId} was not available after activation.`);
		}
		if (finalTab.active !== true) {
			return errorResult("INTERNAL_ERROR", `Chrome did not report tab ${tabId} as active.`);
		}
		return {
			content: [{
				type: "text",
				text: JSON.stringify({
					tabId: finalTab.id,
					title: typeof finalTab.title === "string" ? finalTab.title : "",
					url: typeof finalTab.url === "string" ? finalTab.url : "",
					active: finalTab.active === true,
				}),
			}],
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/\b(no tab|tab.+not found|invalid tab)\b/i.test(message)) {
			return errorResult("TAB_NOT_FOUND", message);
		}
		return errorResult("INTERNAL_ERROR", message || "Failed to activate the browser tab.");
	}
}

function isValidArguments(args) {
	if (!args || typeof args !== "object" || Array.isArray(args)) return false;
	const keys = Object.keys(args);
	return keys.length === 1 && keys[0] === "tabId" && Number.isInteger(args.tabId);
}

function errorResult(code, message) {
	return {
		content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
		isError: true,
	};
}
