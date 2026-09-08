import { afterEach, describe, expect, it } from "bun:test";
import { createServer, type Server } from "node:net";
import { BrowserTransportError, createRequestContext } from "./protocol";
import { LocalRelayTransport } from "./local-relay-transport";

const PATH = "/extension/v2";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

function nextPort(): Promise<number> {
	return new Promise((resolve) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			server.close(() => resolve(port));
		});
	});
}

function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

function track<T extends { close(): unknown }>(t: T): T {
	cleanups.push(() => t.close());
	return t;
}

/** Fake extension：用运行时自带 WebSocket 客户端模拟真实扩展侧的收发形状。 */
class FakeExtension {
	private ws!: WebSocket;
	private readonly received: string[] = [];

	connect(url: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(url);
			ws.onopen = () => {
				this.ws = ws;
				resolve();
			};
			ws.onerror = () => reject(new Error("fake extension failed to connect"));
			ws.onmessage = (ev) => this.received.push(String(ev.data));
		});
	}

	close() {
		try {
			this.ws?.close();
		} catch {}
	}

	send(message: unknown) {
		this.ws.send(JSON.stringify(message));
	}

	sendHandshake(extra?: Record<string, unknown>) {
		this.send({
			method: "extensionInfo",
			params: {
				extensionVersion: "1.5.8",
				version: "1.5.8",
				capabilities: ["fifo-command-queue", "v2-connection-status"],
				browserType: "chrome",
				browserClientId: "fake-client-1",
				displayName: "Fake Chrome",
				...extra,
			},
		});
	}

	receivedSnapshot(): string[] {
		return [...this.received];
	}
}

async function pollForMessage(
	ext: FakeExtension,
	predicate: (m: Record<string, unknown>) => boolean,
	timeoutMs = 2000,
): Promise<Record<string, unknown>> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		for (const raw of ext.receivedSnapshot()) {
			const m = JSON.parse(raw) as Record<string, unknown>;
			if (predicate(m)) return m;
		}
		await sleep(10);
	}
	throw new Error("did not receive expected message in time");
}

async function connectedPair(opts?: { requestTimeoutMs?: number }) {
	const port = await nextPort();
	const transport = track(new LocalRelayTransport({ port, host: "127.0.0.1", ...opts }));
	await transport.connect();
	const ext = track(new FakeExtension());
	await ext.connect(`ws://127.0.0.1:${port}${PATH}`);
	ext.sendHandshake();
	await sleep(50);
	return { transport, ext, port };
}

describe("LocalRelayTransport connect/handshake", () => {
	it("listens on loopback, accepts /extension/v2 and becomes connected after extensionInfo", async () => {
		const { transport } = await connectedPair();
		expect(transport.state).toBe("connected");
		expect(transport.kind).toBe("local-relay");
	});

	it("advertises v2 connection status so the extension skips the legacy /extension bridge", async () => {
		const port = await nextPort();
		const transport = track(new LocalRelayTransport({ port }));
		await transport.connect();

		const response = await fetch(`http://127.0.0.1:${port}/app/info`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toEqual({
			appName: "Pi Browser Bridge",
			relayCapabilities: ["v2-connection-status"],
		});
	});

	it("rejects a client that reports an unsupported protocolVersion", async () => {
		const port = await nextPort();
		const transport = track(new LocalRelayTransport({ port }));
		await transport.connect();

		const ext = track(new FakeExtension());
		await ext.connect(`ws://127.0.0.1:${port}${PATH}`);
		ext.sendHandshake({ protocolVersion: 99 });
		await sleep(100);

		expect(transport.state).not.toBe("connected");
	});

	it("fails with port_unavailable when the port is taken", async () => {
		const blocker = track(createServer());
		await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
		const port = (blocker.address() as { port: number }).port;

		const transport = new LocalRelayTransport({ port });
		const error = await transport.connect().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(BrowserTransportError);
		expect((error as BrowserTransportError).code).toBe("port_unavailable");
	});

	it("does not accept the legacy /extension path", async () => {
		const port = await nextPort();
		const transport = track(new LocalRelayTransport({ port }));
		await transport.connect();

		const bad = new WebSocket(`ws://127.0.0.1:${port}/extension`);
		const outcome = await new Promise<string>((resolve) => {
			// 拒绝形态：服务端直接关闭 TCP/HTTP 400，客户端表现为 onerror 或 onclose
			bad.onerror = () => resolve("error");
			bad.onclose = () => resolve("close");
			setTimeout(() => resolve("timeout"), 1500);
		});
		expect(["error", "close"]).toContain(outcome);
		expect(transport.state).not.toBe("connected");
	});
});

describe("LocalRelayTransport discover and invoke", () => {
	it("discovers tools via tools/discover", async () => {
		const { transport, ext } = await connectedPair();

		const discovery = transport.discoverTools();
		const request = await pollForMessage(ext, (m) => m.method === "tools/discover");
		expect(typeof request.id).toBe("number");
		ext.send({ id: request.id, result: { tools: [{ name: "list_tabs", description: "", inputSchema: {} }] } });

		const tools = await discovery;
		expect(tools).toHaveLength(1);
		expect(tools[0].name).toBe("list_tabs");
	});

	it("invokes a tool and maps a result response", async () => {
		const { transport, ext } = await connectedPair();
		const ctx = createRequestContext({ requestId: "i1", sessionId: "s1" });

		const pending = transport.invoke("list_tabs", {}, ctx);
		const request = await pollForMessage(
			ext,
			(m) => m.method === "tools/invoke" && (m.params as { tool: string }).tool === "list_tabs",
		);
		ext.send({ id: request.id, result: { tabs: [{ id: 1, title: "T", url: "https://t" }] } });

		const result = await pending;
		expect(result.status).toBe("success");
		expect(JSON.stringify(result.evidence)).toContain("https://t");
	});

	it("maps a legacy error envelope via legacy-envelope codes", async () => {
		const { transport, ext } = await connectedPair();
		const ctx = createRequestContext({ requestId: "i2", sessionId: "s1" });

		const pending = transport.invoke("computer", {}, ctx);
		const request = await pollForMessage(ext, (m) => m.method === "tools/invoke");
		ext.send({ id: request.id, error: { code: "QUEUE_FULL", message: "Tool command queue is full" } });

		const error = await pending.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(BrowserTransportError);
		expect((error as BrowserTransportError).code).toBe("queue_full");
		expect((error as BrowserTransportError).retryable).toBe(true);
	});

	it("times out a request that never gets a response", async () => {
		const { transport } = await connectedPair({ requestTimeoutMs: 100 });
		const ctx = createRequestContext({ requestId: "i3", sessionId: "s1" });

		const error = await transport.invoke("noop", {}, ctx).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(BrowserTransportError);
		expect((error as BrowserTransportError).code).toBe("timeout");
	});

	it("fails in-flight requests with client_not_connected when the extension drops", async () => {
		const { transport, ext } = await connectedPair({ requestTimeoutMs: 5_000 });
		const ctx = createRequestContext({ requestId: "i4", sessionId: "s1" });

		const pending = transport.invoke("slow", {}, ctx);
		await pollForMessage(ext, (m) => m.method === "tools/invoke");
		ext.close();

		const error = await pending.catch((e: unknown) => e);
		expect((error as BrowserTransportError).code).toBe("client_not_connected");
		expect(transport.state).not.toBe("connected");
	});

	it("honors AbortSignal with a cancelled error", async () => {
		const { transport } = await connectedPair({ requestTimeoutMs: 5_000 });
		const ctx = createRequestContext({ requestId: "i5", sessionId: "s1" });
		const controller = new AbortController();
		const pending = transport.invoke("slow", {}, ctx, controller.signal);
		controller.abort();

		const error = await pending.catch((e: unknown) => e);
		expect((error as BrowserTransportError).code).toBe("cancelled");
	});

	it("recovers to connected when the extension reconnects", async () => {
		const { transport, ext, port } = await connectedPair();
		ext.close();
		await sleep(80);
		expect(transport.state).not.toBe("connected");

		const ext2 = track(new FakeExtension());
		await ext2.connect(`ws://127.0.0.1:${port}${PATH}`);
		ext2.sendHandshake();
		await sleep(50);
		expect(transport.state).toBe("connected");
	});
});
