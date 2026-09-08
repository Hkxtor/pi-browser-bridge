import { describe, expect, it } from "bun:test";
import {
	legacyErrorToTransportError,
	mapLegacyErrorCode,
	parseLegacyEnvelope,
	encodeDiscoverResult,
	encodeInvokeResult,
} from "./legacy-envelope";

describe("legacy envelope parsing", () => {
	it("parses ping requests", () => {
		const parsed = parseLegacyEnvelope({ method: "ping" });
		expect(parsed).toEqual({ kind: "ping" });
	});

	it("parses tools/discover with a numeric id", () => {
		expect(parseLegacyEnvelope({ id: 7, method: "tools/discover" })).toEqual({
			kind: "discover",
			id: 7,
		});
	});

	it("rejects discover without a numeric id", () => {
		expect(parseLegacyEnvelope({ id: "7", method: "tools/discover" })).toBeNull();
		expect(parseLegacyEnvelope({ method: "tools/discover" })).toBeNull();
	});

	it("parses tools/invoke with tool and arguments, defaulting missing arguments to {}", () => {
		expect(
			parseLegacyEnvelope({ id: 9, method: "tools/invoke", params: { tool: "page.text" } }),
		).toEqual({ kind: "invoke", id: 9, tool: "page.text", arguments: {} });

		expect(
			parseLegacyEnvelope({
				id: 10,
				method: "tools/invoke",
				params: { tool: "element.click", arguments: { ref: "ref_1" } },
			}),
		).toEqual({ kind: "invoke", id: 10, tool: "element.click", arguments: { ref: "ref_1" } });
	});

	it("rejects invoke without a tool name", () => {
		expect(parseLegacyEnvelope({ id: 1, method: "tools/invoke", params: {} })).toBeNull();
	});

	it("returns null for unknown or malformed messages", () => {
		expect(parseLegacyEnvelope(null)).toBeNull();
		expect(parseLegacyEnvelope("tools/discover")).toBeNull();
		expect(parseLegacyEnvelope({ method: "unknown" })).toBeNull();
	});
});

describe("legacy error code mapping", () => {
	it("maps known legacy codes to normalized lowercase codes", () => {
		expect(mapLegacyErrorCode("QUEUE_FULL")).toBe("queue_full");
		expect(mapLegacyErrorCode("TAB_NOT_FOUND")).toBe("tab_not_found");
		expect(mapLegacyErrorCode("COMMAND_TIMEOUT")).toBe("command_timeout");
		expect(mapLegacyErrorCode("TIMEOUT")).toBe("timeout");
	});

	it("falls back to internal_error for unknown codes and null", () => {
		expect(mapLegacyErrorCode("SOMETHING_NEW")).toBe("internal_error");
		expect(mapLegacyErrorCode(undefined)).toBe("internal_error");
	});

	it("converts legacy errors to transport errors with retryability", () => {
		const busy = legacyErrorToTransportError({ code: "QUEUE_FULL", message: "Tool command queue is full" });
		expect(busy.code).toBe("queue_full");
		expect(busy.retryable).toBe(true);

		const missing = legacyErrorToTransportError({ code: "TAB_NOT_FOUND", message: "Tab not found" });
		expect(missing.code).toBe("tab_not_found");
		expect(missing.retryable).toBe(false);
	});
});

describe("legacy envelope encoding", () => {
	it("encodes discover results", () => {
		expect(encodeDiscoverResult(7, [{ name: "page.text" }])).toEqual({
			id: 7,
			result: { tools: [{ name: "page.text" }] },
		});
	});

	it("encodes invoke success and error shapes", () => {
		expect(encodeInvokeResult(9, { ok: true })).toEqual({ id: 9, result: { ok: true } });
		expect(encodeInvokeResult(9, undefined, { code: "TAB_NOT_FOUND", message: "gone" })).toEqual({
			id: 9,
			error: { code: "TAB_NOT_FOUND", message: "gone" },
		});
	});
});
