import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../../..");
const NATIVE_WATCH_DISCONNECT_HANDLER =
	"m=()=>{void chrome.runtime.lastError;if(e.nativeWatchPort===f&&";

for (const relativePath of ["background.js"]) {
	describe(relativePath, () => {
		it("consumes runtime.lastError before falling back from a missing native messaging host", () => {
			const source = readFileSync(resolve(REPOSITORY_ROOT, relativePath), "utf8");
			expect(source).toContain(NATIVE_WATCH_DISCONNECT_HANDLER);
		});

		it("wires the readable tabs_activate module into discovery and invocation", () => {
			const source = readFileSync(resolve(REPOSITORY_ROOT, relativePath), "utf8");
			expect(source).toStartWith(
				'import { handleTabsActivate, tabsActivateDefinition } from "./background-tab-activation.js";',
			);
			expect(source).toContain("const Un=[tabsActivateDefinition,");
			expect(source).toContain("tabs_activate:handleTabsActivate");
			expect(source).toContain("Ut=Un.map(Wn)");
		});
	});
}
