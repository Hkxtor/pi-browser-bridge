import { describe, expect, it } from "bun:test";
import {
	createBrowserTransport,
	READY_TIMEOUT_DEFAULT_MS,
	READY_TIMEOUT_MAX_MS,
	RELAY_PORT_DEFAULT,
	resolveReadyTimeoutMs,
	resolveSessionGrant,
	resolveTransportConfig,
} from "./config";
import { LocalRelayTransport } from "./local-relay-transport";
import { UnconfiguredBrowserTransport } from "./transport";

describe("resolveTransportConfig", () => {
	const envOf = (patch: Record<string, string | undefined> = {}) => {
		const env: Record<string, string | undefined> = { ...process.env };
		delete env.PI_BROWSER_TRANSPORT;
		delete env.PI_BROWSER_RELAY_HOST;
		delete env.PI_BROWSER_RELAY_PORT;
		return { ...env, ...patch };
	};

	it(`defaults to local-relay on 127.0.0.1:${RELAY_PORT_DEFAULT}`, () => {
		const config = resolveTransportConfig(envOf());
		expect(config).toEqual({ mode: "local-relay", host: "127.0.0.1", port: RELAY_PORT_DEFAULT, readyTimeoutMs: 8000 });
		expect(RELAY_PORT_DEFAULT).toBe(16789);
	});

	it("honors explicit loopback and port overrides", () => {
		const config = resolveTransportConfig(
			envOf({ PI_BROWSER_RELAY_HOST: "localhost", PI_BROWSER_RELAY_PORT: "16791" }),
		);
		expect(config).toEqual({ mode: "local-relay", host: "localhost", port: 16791, readyTimeoutMs: 8000 });
	});

	it("switches to the unconfigured skeleton via PI_BROWSER_TRANSPORT", () => {
		const config = resolveTransportConfig(envOf({ PI_BROWSER_TRANSPORT: "unconfigured" }));
		expect(config.mode).toBe("unconfigured");
	});

	it("rejects non-loopback hosts", () => {
		for (const host of ["0.0.0.0", "192.168.1.10", "10.0.0.5", "example.com"]) {
			expect(() => resolveTransportConfig(envOf({ PI_BROWSER_RELAY_HOST: host }))).toThrow(
				/loopback/i,
			);
		}
	});

	it("rejects an invalid port", () => {
		expect(() => resolveTransportConfig(envOf({ PI_BROWSER_RELAY_PORT: "abc" }))).toThrow();
		expect(() => resolveTransportConfig(envOf({ PI_BROWSER_RELAY_PORT: "0" }))).toThrow();
		expect(() => resolveTransportConfig(envOf({ PI_BROWSER_RELAY_PORT: "70000" }))).toThrow();
	});
});

describe("resolveReadyTimeoutMs", () => {
	const envOf = (patch: Record<string, string | undefined> = {}) => {
		const env: Record<string, string | undefined> = { ...process.env };
		delete env.PI_BROWSER_READY_TIMEOUT_MS;
		return { ...env, ...patch };
	};

	it("defaults to 8000 when the env var is absent", () => {
		expect(resolveReadyTimeoutMs(envOf())).toBe(READY_TIMEOUT_DEFAULT_MS);
		expect(READY_TIMEOUT_DEFAULT_MS).toBe(8000);
	});

	it("honors an explicit in-range timeout", () => {
		expect(resolveReadyTimeoutMs(envOf({ PI_BROWSER_READY_TIMEOUT_MS: "500" }))).toBe(500);
	});

	it("treats 0 as disabling the ready wait", () => {
		expect(resolveReadyTimeoutMs(envOf({ PI_BROWSER_READY_TIMEOUT_MS: "0" }))).toBe(0);
	});

	it("normalizes non-numeric and empty values to the default", () => {
		for (const value of ["abc", "", "   ", "10s"]) {
			expect(resolveReadyTimeoutMs(envOf({ PI_BROWSER_READY_TIMEOUT_MS: value }))).toBe(
				READY_TIMEOUT_DEFAULT_MS,
			);
		}
	});

	it("normalizes non-integer numbers to the default", () => {
		expect(resolveReadyTimeoutMs(envOf({ PI_BROWSER_READY_TIMEOUT_MS: "8000.5" }))).toBe(
			READY_TIMEOUT_DEFAULT_MS,
		);
	});

	it("clamps negative values to 0 (disabled)", () => {
		for (const value of ["-1", "-5", "-30000"]) {
			expect(resolveReadyTimeoutMs(envOf({ PI_BROWSER_READY_TIMEOUT_MS: value }))).toBe(0);
		}
	});

	it("clamps values above the maximum to 30000", () => {
		expect(READY_TIMEOUT_MAX_MS).toBe(30000);
		for (const value of ["30001", "99999"]) {
			expect(resolveReadyTimeoutMs(envOf({ PI_BROWSER_READY_TIMEOUT_MS: value }))).toBe(
				READY_TIMEOUT_MAX_MS,
			);
		}
	});

	it("keeps the boundary values 0 and 30000", () => {
		expect(resolveReadyTimeoutMs(envOf({ PI_BROWSER_READY_TIMEOUT_MS: "30000" }))).toBe(30000);
	});
});

describe("resolveSessionGrant", () => {
	it("defaults to false when env var is absent", () => {
		expect(
			resolveSessionGrant({ ...process.env, PI_BROWSER_SESSION_GRANT: undefined }),
		).toBe(false);
	});

	it("returns false when the env var is explicitly '0'", () => {
		expect(
			resolveSessionGrant({ ...process.env, PI_BROWSER_SESSION_GRANT: "0" }),
		).toBe(false);
	});

	it("returns true only for explicit opt-in values", () => {
		for (const val of ["1", "true", "yes", "on"]) {
			expect(
				resolveSessionGrant({ ...process.env, PI_BROWSER_SESSION_GRANT: val }),
			).toBe(true);
		}
	});
});

describe("createBrowserTransport", () => {
	it("creates a LocalRelayTransport in default mode", () => {
		const transport = createBrowserTransport({
			mode: "local-relay",
			host: "127.0.0.1",
			port: RELAY_PORT_DEFAULT,
		});
		expect(transport).toBeInstanceOf(LocalRelayTransport);
		expect(transport.kind).toBe("local-relay");
	});

	it("creates the unconfigured skeleton in unconfigured mode", () => {
		const transport = createBrowserTransport({
			mode: "unconfigured",
			host: "127.0.0.1",
			port: RELAY_PORT_DEFAULT,
		});
		expect(transport).toBeInstanceOf(UnconfiguredBrowserTransport);
		expect(transport.kind).toBe("unconfigured");
	});
});
