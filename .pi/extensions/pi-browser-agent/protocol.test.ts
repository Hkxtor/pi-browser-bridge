import { describe, expect, it } from "bun:test";
import {
	BrowserTransportError,
	createErrorResult,
	createRequestContext,
	createSuccessResult,
} from "./protocol";
import { MockBrowserTransport, UnconfiguredBrowserTransport } from "./transport";

describe("browser agent protocol", () => {
	it("creates a stable request context without losing the target tab", () => {
		expect(
			createRequestContext({
				requestId: "call-1",
				sessionId: "session-1",
				tabId: 7,
			}),
		).toEqual({
			requestId: "call-1",
			sessionId: "session-1",
			tabId: 7,
		});
	});

	it("uses the shared result envelope for successful calls", () => {
		expect(
			createSuccessResult("Connected", { transport: "mock" }, "Ready for discovery"),
		).toEqual({
			status: "success",
			summary: "Connected",
			evidence: { transport: "mock" },
			next: "Ready for discovery",
		});
	});

	it("uses stable retry metadata for errors", () => {
		const error = new BrowserTransportError(
			"controller_transport_unconfigured",
			"No controller-facing transport has been configured.",
			false,
		);

		expect(createErrorResult(error)).toEqual({
			status: "error",
			summary: "No controller-facing transport has been configured.",
			evidence: undefined,
		next: "Configure a controller transport before retrying.",
			error: {
				code: "controller_transport_unconfigured",
				retryable: false,
			},
		});
	});
});

describe("unconfigured browser transport", () => {
	it("fails closed instead of making an implicit network connection", async () => {
		const transport = new UnconfiguredBrowserTransport();

		await expect(transport.connect()).rejects.toMatchObject({
			code: "controller_transport_unconfigured",
			retryable: false,
		});
		expect(transport.state).toBe("disconnected");
	});
});

describe("mock browser transport", () => {
	it("supports discovery, invocation, cancellation, and close", async () => {
		const transport = new MockBrowserTransport({
			tools: [
				{
					name: "browser.page.text",
					description: "Read bounded page text",
					inputSchema: { type: "object" },
					risk: "read",
				},
			],
		});

		await transport.connect();
		expect(transport.state).toBe("connected");
		expect(await transport.discoverTools()).toHaveLength(1);

		const result = await transport.invoke(
			"browser.page.text",
			{ maxChars: 1000 },
			createRequestContext({ requestId: "call-2", sessionId: "session-1" }),
		);
		expect(result).toMatchObject({ status: "success" });

		await transport.cancel("call-2");
		expect(transport.cancelledRequestIds).toEqual(["call-2"]);

		await transport.close();
		expect(transport.state).toBe("closed");
	});
});
