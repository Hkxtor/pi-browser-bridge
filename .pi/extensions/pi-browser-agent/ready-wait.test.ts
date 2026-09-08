import { afterEach, describe, expect, it } from "bun:test";
import { createServer } from "node:net";
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

/** Fake extension：与 local-relay-transport.test.ts 相同的 WS 模拟形状。 */
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

	receivedMessages(): Record<string, unknown>[] {
		return this.received.map((raw) => JSON.parse(raw) as Record<string, unknown>);
	}
}

async function listeningTransport(opts?: { readyTimeoutMs?: number }) {
	const port = await nextPort();
	const transport = track(new LocalRelayTransport({ port, host: "127.0.0.1", ...opts }));
	await transport.connect();
	return { transport, port };
}

describe("warming state machine", () => {
	it("reports disconnected before listen and warming once listening without a client", async () => {
		const port = await nextPort();
		const transport = track(new LocalRelayTransport({ port, host: "127.0.0.1" }));
		expect(transport.state).toBe("disconnected");

		await transport.connect();
		expect(transport.state).toBe("warming");
	});

	it("transitions warming → connected after the extension handshake", async () => {
		const { transport, port } = await listeningTransport();
		const ext = track(new FakeExtension());
		await ext.connect(`ws://127.0.0.1:${port}${PATH}`);
		// 已建立 ws 但未握手：仍在 warming
		expect(transport.state).toBe("warming");

		ext.sendHandshake();
		await sleep(50);
		expect(transport.state).toBe("connected");
	});

	it("falls back to warming (not disconnected) when the extension drops while the server lives", async () => {
		const { transport, port } = await listeningTransport();
		const ext = track(new FakeExtension());
		await ext.connect(`ws://127.0.0.1:${port}${PATH}`);
		ext.sendHandshake();
		await sleep(50);
		expect(transport.state).toBe("connected");

		ext.close();
		await sleep(80);
		expect(transport.state).toBe("warming");
	});

	it("transitions to closed after close() and rejects further state changes", async () => {
		const { transport } = await listeningTransport();
		await transport.close();
		expect(transport.state).toBe("closed");
	});
});

describe("waitForReady", () => {
	it("resolves once the extension handshakes within the window; invoke then succeeds once", async () => {
		const { transport, port } = await listeningTransport({ readyTimeoutMs: 2000 });
		expect(transport.state).toBe("warming");

		const waiting = transport.waitForReady();
		await sleep(30);
		const ext = track(new FakeExtension());
		await ext.connect(`ws://127.0.0.1:${port}${PATH}`);
		ext.sendHandshake();

		await waiting;
		expect(transport.state).toBe("connected");
		// 等待期间扩展不应收到任何 tools/invoke
		expect(ext.receivedMessages().filter((m) => m.method === "tools/invoke")).toHaveLength(0);

		const ctx = createRequestContext({ requestId: "rw-1", sessionId: "s1" });
		const pending = transport.invoke("tabs_context", {}, ctx);
		await sleep(30);
		const invokeMsgs = ext.receivedMessages().filter((m) => m.method === "tools/invoke");
		expect(invokeMsgs).toHaveLength(1);
		ext.send({ id: invokeMsgs[0].id, result: { ok: true } });
		const result = await pending;
		expect(result.status).toBe("success");
	});

	it("resolves immediately when already connected", async () => {
		const { transport, port } = await listeningTransport({ readyTimeoutMs: 100 });
		const ext = track(new FakeExtension());
		await ext.connect(`ws://127.0.0.1:${port}${PATH}`);
		ext.sendHandshake();
		await sleep(50);
		expect(transport.state).toBe("connected");

		// 已连接时不受 readyTimeoutMs 限制，立即返回
		await transport.waitForReady();
	});

	it("times out with a retryable browser_not_ready carrying state and timeoutMs", async () => {
		const { transport } = await listeningTransport({ readyTimeoutMs: 100 });

		const error = await transport.waitForReady().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(BrowserTransportError);
		expect((error as BrowserTransportError).code).toBe("browser_not_ready");
		expect((error as BrowserTransportError).retryable).toBe(true);
		const details = (error as BrowserTransportError).details as {
			state?: string;
			timeoutMs?: number;
		};
		expect(details.state).toBe("warming");
		expect(details.timeoutMs).toBe(100);
		expect(transport.state).toBe("warming");
	});

	it("honors AbortSignal during the wait with cancelled and no extension traffic", async () => {
		const { transport, port } = await listeningTransport({ readyTimeoutMs: 5000 });
		const ext = track(new FakeExtension());
		await ext.connect(`ws://127.0.0.1:${port}${PATH}`);

		const controller = new AbortController();
		const waiting = transport.waitForReady(controller.signal);
		controller.abort();

		const error = await waiting.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(BrowserTransportError);
		expect((error as BrowserTransportError).code).toBe("cancelled");
		expect(ext.receivedMessages().filter((m) => m.method === "tools/invoke")).toHaveLength(0);
	});

	it("rejects an already-aborted signal immediately", async () => {
		const { transport } = await listeningTransport({ readyTimeoutMs: 100 });
		const controller = new AbortController();
		controller.abort();

		const error = await transport.waitForReady(controller.signal).catch((e: unknown) => e);
		expect((error as BrowserTransportError).code).toBe("cancelled");
	});

	it("skips the wait entirely when readyTimeoutMs is 0 (legacy immediate behavior)", async () => {
		const { transport } = await listeningTransport({ readyTimeoutMs: 0 });

		const error = await transport.waitForReady().catch((e: unknown) => e);
		expect(error).toBeInstanceOf(BrowserTransportError);
		expect((error as BrowserTransportError).code).toBe("client_not_connected");
	});

	it("close() rejects in-flight waiters and frees the port", async () => {
		const { transport, port } = await listeningTransport({ readyTimeoutMs: 5000 });

		const waiting = transport.waitForReady();
		await sleep(20);
		await transport.close();

		const error = await waiting.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(BrowserTransportError);
		expect((error as BrowserTransportError).code).toBe("closing");
		expect(transport.state).toBe("closed");

		// 端口已释放：同端口可立即再监听
		const probe = createServer();
		await new Promise<void>((resolve, reject) => {
			probe.once("error", reject);
			probe.listen(port, "127.0.0.1", () => resolve());
		});
		await new Promise<void>((resolve) => probe.close(() => resolve()));
	});
});
