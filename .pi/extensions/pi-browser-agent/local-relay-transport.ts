import { legacyErrorToTransportError } from "./legacy-envelope";
import {
	BrowserTransportError,
	createSuccessResult,
} from "./protocol";
import type {
	BrowserRequestContext,
	BrowserToolDefinition,
	BrowserToolResult,
	BrowserTransportState,
} from "./protocol";
import { startMinimalWsServer } from "./minimal-ws";
import type { MinimalWsConnection, MinimalWsServer } from "./minimal-ws";

export interface LocalRelayTransportOptions {
	port: number;
	host?: string;
	path?: string;
	requestTimeoutMs?: number;
	readyTimeoutMs?: number;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
	timer?: ReturnType<typeof setTimeout>;
	signal?: AbortSignal;
	onAbort?: () => void;
}

/** 就绪等待者：与 PendingRequest 同登记/注销形状。 */
interface ReadyWaiter {
	resolve: () => void;
	reject: (error: unknown) => void;
	timer?: ReturnType<typeof setTimeout>;
	signal?: AbortSignal;
	onAbort?: () => void;
}

const SUPPORTED_PROTOCOL_VERSION = 1;
const RELAY_APP_INFO = {
	appName: "Pi Browser Bridge",
	relayCapabilities: ["v2-connection-status"],
} as const;

export class LocalRelayTransport {
	readonly kind = "local-relay";
	private currentState: BrowserTransportState = "disconnected";
	private server: MinimalWsServer | null = null;
	private client: MinimalWsConnection | null = null;
	private requestId = 0;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly waiters = new Set<ReadyWaiter>();

	private readonly host: string;
	private readonly port: number;
	private readonly path: string;
	private readonly requestTimeoutMs: number;
	readonly readyTimeoutMs: number;

	get state(): BrowserTransportState {
		return this.currentState;
	}

	constructor(options: LocalRelayTransportOptions) {
		this.host = options.host ?? "127.0.0.1";
		this.port = options.port;
		this.path = options.path ?? "/extension/v2";
		this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
		this.readyTimeoutMs = options.readyTimeoutMs ?? 8_000;
	}

	async connect(signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		if (this.server) return;
		try {
			this.currentState = "warming";
			this.server = await startMinimalWsServer(
				{ host: this.host, port: this.port, path: this.path, appInfo: RELAY_APP_INFO },
				{
					onConnection: (conn) => this.onConnection(conn),
					onMessage: (conn, text) => this.onMessage(conn, text),
					onClose: (conn) => this.onClose(conn),
				},
			);
		} catch (cause) {
			this.currentState = "disconnected";
			throw mapListenError(cause, this.port, this.host);
		}
	}

	/**
	 * 有界就绪等待（R3-R6）：
	 * - 已 connected：立即返回
	 * - closed：closing 错误
	 * - readyTimeoutMs === 0：不等待，立即 client_not_connected（兼容旧行为）
	 * - 否则事件驱动等待：connected 时 resolve；超时 browser_not_ready；abort → cancelled
	 */
	async waitForReady(signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		if (this.currentState === "connected" && this.client) return;
		if (this.currentState === "closed") {
			throw new BrowserTransportError("closing", "Transport closed.", false);
		}
		if (this.readyTimeoutMs === 0) {
			throw new BrowserTransportError(
				"client_not_connected",
				"Browser extension is not connected.",
				true,
			);
		}
		return new Promise<void>((resolve, reject) => {
			const waiter: ReadyWaiter = { resolve, reject, signal };
			waiter.timer = setTimeout(() => {
				this.waiters.delete(waiter);
				signal?.removeEventListener("abort", waiter.onAbort as EventListener);
				reject(
					new BrowserTransportError(
						"browser_not_ready",
						`Browser extension did not connect within ${this.readyTimeoutMs}ms (state: ${this.currentState}). Start or reload the Chrome extension, then retry.`,
						true,
						{ state: this.currentState, timeoutMs: this.readyTimeoutMs },
					),
				);
			}, this.readyTimeoutMs);
			if (signal) {
				waiter.onAbort = () => {
					this.waiters.delete(waiter);
					waiter.timer && clearTimeout(waiter.timer);
					reject(new BrowserTransportError("cancelled", "Ready wait was cancelled.", false));
				};
				signal.addEventListener("abort", waiter.onAbort as EventListener, { once: true });
			}
			this.waiters.add(waiter);
		});
	}

	async discoverTools(signal?: AbortSignal): Promise<readonly BrowserToolDefinition[]> {
		throwIfAborted(signal);
		const result = await this.request("tools/discover", undefined, signal);
		const tools = (result as { tools?: BrowserToolDefinition[] } | undefined)?.tools;
		if (!Array.isArray(tools)) {
			throw new BrowserTransportError(
				"invalid_transport_result",
				"tools/discover did not return a tools array.",
				true,
				result,
			);
		}
		return tools;
	}

	async invoke(
		toolName: string,
		arguments_: unknown,
		context: BrowserRequestContext,
		signal?: AbortSignal,
	): Promise<BrowserToolResult> {
		void context;
		throwIfAborted(signal);
		const result = await this.request(
			"tools/invoke",
			{ tool: toolName, arguments: arguments_ ?? {} },
			signal,
		);
		return createSuccessResult(
			`Tool ${toolName} executed on the browser extension.`,
			result,
			"Element refs expire when the page changes; fresh snapshots return new refs.",
		);
	}

	async close(): Promise<void> {
		this.failAllWaiters(new BrowserTransportError("closing", "Transport closed.", false));
		this.failAllPending(new BrowserTransportError("closing", "Transport closed.", false));
		this.client?.close();
		this.client = null;
		if (this.server) {
			await this.server.close();
			this.server = null;
		}
		this.currentState = "closed";
	}

	// -- internals ----------------------------------------------------------

	private onConnection(conn: MinimalWsConnection): void {
		// 单客户端：新连接顶掉旧连接
		if (this.client && this.client !== conn) {
			try {
				this.client.close(1013, "superseded by a new extension connection");
			} catch {
				/* ignore */
			}
		}
		this.client = conn;
		// 等 extensionInfo 再进入 connected
		this.currentState = "warming";
	}

	private onMessage(conn: MinimalWsConnection, text: string): void {
		if (conn !== this.client) return;
		let message: unknown;
		try {
			message = JSON.parse(text);
		} catch {
			return;
		}
		const m = message as Record<string, unknown>;
		if (m.method === "extensionInfo") {
			this.onExtensionInfo(m);
			return;
		}
		if (typeof m.id === "number") {
			const entry = this.pending.get(m.id);
			if (!entry) return;
			this.pending.delete(m.id);
			entry.timer && clearTimeout(entry.timer);
			entry.signal?.removeEventListener("abort", entry.onAbort as EventListener);
			if (m.error && typeof m.error === "object") {
				entry.reject(
					legacyErrorToTransportError(m.error as { code?: string; message?: string }),
				);
			} else {
				entry.resolve(m.result);
			}
		}
	}

	private onExtensionInfo(message: Record<string, unknown>): void {
		const params = (message.params ?? {}) as Record<string, unknown>;
		const protocolVersion = typeof params.protocolVersion === "number" ? params.protocolVersion : SUPPORTED_PROTOCOL_VERSION;
		if (protocolVersion !== SUPPORTED_PROTOCOL_VERSION) {
			try {
				this.client?.close(1008, `protocolVersion ${protocolVersion} is not supported`);
			} catch {
				/* ignore */
			}
			this.client = null;
			this.failAllPending(
				new BrowserTransportError(
					"protocol_version_unsupported",
					"Extension reported an unsupported protocolVersion.",
					false,
				),
			);
			return;
		}
		this.currentState = "connected";
		this.resolveAllWaiters();
	}

	private onClose(conn: MinimalWsConnection): void {
		if (conn !== this.client) return;
		this.client = null;
		// server 仍在监听 → 回到 warming 等待扩展重连，而非 disconnected
		this.currentState = this.server ? "warming" : "disconnected";
		this.failAllPending(
			new BrowserTransportError(
				"client_not_connected",
				"The browser extension disconnected.",
				true,
			),
		);
	}

	private request(
		method: string,
		params: Record<string, unknown> | undefined,
		signal?: AbortSignal,
	): Promise<unknown> {
		if (this.currentState !== "connected" || !this.client) {
			return Promise.reject(
				new BrowserTransportError(
					"client_not_connected",
					"Browser extension is not connected.",
					true,
				),
			);
		}
		const id = ++this.requestId;
		const message = params === undefined ? { id, method } : { id, method, params };

		return new Promise((resolve, reject) => {
			const entry: PendingRequest = { resolve, reject, signal };
			entry.timer = setTimeout(() => {
				this.pending.delete(id);
				reject(
					new BrowserTransportError(
						"timeout",
						`Request ${method} did not complete within ${this.requestTimeoutMs}ms.`,
						true,
					),
				);
			}, this.requestTimeoutMs);

			if (signal) {
				entry.onAbort = () => {
					this.pending.delete(id);
					entry.timer && clearTimeout(entry.timer);
					reject(new BrowserTransportError("cancelled", "Request was cancelled.", false));
				};
				signal.addEventListener("abort", entry.onAbort as EventListener, { once: true });
			}

			this.pending.set(id, entry);
			try {
				this.client!.sendText(JSON.stringify(message));
			} catch (cause) {
				this.pending.delete(id);
				entry.timer && clearTimeout(entry.timer);
				reject(
					new BrowserTransportError(
						"internal_error",
						`Failed to send ${method}: ${cause instanceof Error ? cause.message : String(cause)}`,
						true,
					),
				);
			}
		});
	}

	private resolveAllWaiters(): void {
		for (const waiter of this.waiters) {
			waiter.timer && clearTimeout(waiter.timer);
			waiter.signal?.removeEventListener("abort", waiter.onAbort as EventListener);
			waiter.resolve();
		}
		this.waiters.clear();
	}

	private failAllWaiters(error: BrowserTransportError): void {
		for (const waiter of this.waiters) {
			waiter.timer && clearTimeout(waiter.timer);
			waiter.signal?.removeEventListener("abort", waiter.onAbort as EventListener);
			waiter.reject(error);
		}
		this.waiters.clear();
	}

	private failAllPending(error: BrowserTransportError): void {
		for (const [, entry] of this.pending) {
			entry.timer && clearTimeout(entry.timer);
			entry.signal?.removeEventListener("abort", entry.onAbort as EventListener);
			entry.reject(error);
		}
		this.pending.clear();
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new BrowserTransportError("cancelled", "Operation was cancelled.", false);
	}
}

function mapListenError(cause: unknown, port: number, host: string): BrowserTransportError {
	const errorCode = (cause as NodeJS.ErrnoException | undefined)?.code;
	if (errorCode === "EADDRINUSE") {
		return new BrowserTransportError(
			"port_unavailable",
			`Port ${port} on ${host} is already in use. Stop the other relay client on that port or configure a different port via PI_BROWSER_RELAY_PORT.`,
			false,
			{ cause: errorCode },
		);
	}
	return new BrowserTransportError(
		"transport_open_failed",
		`Failed to listen on ${host}:${port}: ${cause instanceof Error ? cause.message : String(cause)}`,
		true,
	);
}
