import {
	BrowserTransportError,
	createSuccessResult,
} from "./protocol";
import type {
	BrowserPageSnapshot,
	BrowserPageText,
	BrowserRequestContext,
	BrowserScreenshot,
	BrowserTab,
	BrowserToolDefinition,
	BrowserToolResult,
	BrowserTransportState,
} from "./protocol";

export interface BrowserTransport {
	readonly kind: string;
	readonly state: BrowserTransportState;
	/** 就绪等待时长（0 = 禁用等待，立即失败）。 */
	readonly readyTimeoutMs: number;

	connect(signal?: AbortSignal): Promise<void>;
	/** 在调用扩展前有界等待连接就绪；超时 browser_not_ready，取消 cancelled。 */
	waitForReady(signal?: AbortSignal): Promise<void>;
	discoverTools(signal?: AbortSignal): Promise<readonly BrowserToolDefinition[]>;
	invoke(
		toolName: string,
		arguments_: unknown,
		context: BrowserRequestContext,
		signal?: AbortSignal,
	): Promise<BrowserToolResult>;
	cancel(requestId: string): Promise<void>;
	close(): Promise<void>;
}

export class UnconfiguredBrowserTransport implements BrowserTransport {
	readonly kind = "unconfigured";
	readonly readyTimeoutMs = 0;
	private currentState: BrowserTransportState = "disconnected";

	get state(): BrowserTransportState {
		return this.currentState;
	}

	async connect(signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		throw new BrowserTransportError(
			"controller_transport_unconfigured",
			"No controller-facing transport has been configured.",
			false,
		);
	}

	async waitForReady(signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		throw unconfiguredError();
	}

	async discoverTools(signal?: AbortSignal): Promise<readonly BrowserToolDefinition[]> {
		throwIfAborted(signal);
		throw unconfiguredError();
	}

	async invoke(
		_toolName: string,
		_arguments: unknown,
		_context: BrowserRequestContext,
		signal?: AbortSignal,
	): Promise<BrowserToolResult> {
		throwIfAborted(signal);
		throw unconfiguredError();
	}

	async cancel(_requestId: string): Promise<void> {
		return;
	}

	async close(): Promise<void> {
		this.currentState = "closed";
	}
}

export interface MockBrowserTransportOptions {
	tools: readonly BrowserToolDefinition[];
	tabs?: readonly BrowserTab[];
	pageText?: BrowserPageText;
	snapshot?: BrowserPageSnapshot;
	screenshot?: BrowserScreenshot;
	currentSnapshotId?: string;
	failures?: Record<string, BrowserTransportError>;
	// 真实扩展 schemas 的 MCP-style 输出（对应真实扩展的表现）
	tabsContextText?: string;
	pageTextOutput?: string;
	pageTreeText?: string;
	computerResult?: string;
	formInputResult?: string;
}

export interface MockInvocation {
	toolName: string;
	arguments: unknown;
	context: BrowserRequestContext;
}

export class MockBrowserTransport implements BrowserTransport {
	readonly kind = "mock";
	readonly readyTimeoutMs = 0;
	readonly cancelledRequestIds: string[] = [];
	readonly invocations: MockInvocation[] = [];
	/** waitForReady 被调用次数（供权限顺序/接入测试断言）。 */
	waitForReadyCalls = 0;
	private currentState: BrowserTransportState = "disconnected";
	readonly options: MockBrowserTransportOptions;
	readonly failures: Record<string, BrowserTransportError>;

	constructor(options: MockBrowserTransportOptions) {
		this.options = options;
		this.failures = { ...options.failures };
	}

	get state(): BrowserTransportState {
		return this.currentState;
	}

	async connect(signal?: AbortSignal): Promise<void> {
		throwIfAborted(signal);
		if (this.currentState === "closed") {
			throw new BrowserTransportError("transport_closed", "Browser transport is closed.", false);
		}
		this.currentState = "warming";
		throwIfAborted(signal);
		this.currentState = "connected";
	}

	async waitForReady(signal?: AbortSignal): Promise<void> {
		this.waitForReadyCalls++;
		throwIfAborted(signal);
		if (this.currentState === "connected") return;
		if (this.currentState === "closed") {
			throw new BrowserTransportError("transport_closed", "Browser transport is closed.", false);
		}
		throw new BrowserTransportError(
			"client_not_connected",
			"Browser extension is not connected.",
			true,
		);
	}

	async discoverTools(signal?: AbortSignal): Promise<readonly BrowserToolDefinition[]> {
		throwIfAborted(signal);
		this.ensureConnected();
		return [...this.options.tools];
	}

	async invoke(
		toolName: string,
		arguments_: unknown,
		context: BrowserRequestContext,
		signal?: AbortSignal,
	): Promise<BrowserToolResult> {
		throwIfAborted(signal);
		this.ensureConnected();
		const failure = this.failures[toolName];
		if (failure) {
			throw failure;
		}
		if (!this.options.tools.some((tool) => tool.name === toolName)) {
			throw new BrowserTransportError(`tool_not_found`, `Mock tool not found: ${toolName}`, false);
		}

		// stale ref 检查先于 fixture，否则短它能掩盖过期
		const isWrite = toolName === "computer" || toolName === "form_input" || toolName.startsWith("element.");
		if (isWrite && this.options.currentSnapshotId) {
			const args = (arguments_ ?? {}) as { snapshotId?: string };
			if (args.snapshotId && args.snapshotId !== this.options.currentSnapshotId) {
				throw new BrowserTransportError(
					"stale_element_ref",
					`Snapshot ${args.snapshotId} no longer matches the page; expected ${this.options.currentSnapshotId}.`,
					false,
				);
			}
		}

		this.invocations.push({ toolName, arguments: arguments_, context });

		if (
			["tabs_context", "get_page_text", "read_page", "computer", "form_input"].includes(toolName)
		) {
			const fixtureText = this.realFixtureFor(toolName, arguments_);
			if (fixtureText !== null) {
				return createSuccessResult(
					`Mock tool ${toolName}.`,
					{ content: [{ type: "text", text: fixtureText }] },
				);
			}
		}

		const fixture = this.fixtureFor(toolName);
		if (fixture) {
			return fixture;
		}
		return createSuccessResult(
			`Mock invoked ${toolName}.`,
			{ toolName, arguments: arguments_, requestId: context.requestId },
			"Replace the mock transport with a controller transport before using a real browser.",
		);
	}

	async cancel(requestId: string): Promise<void> {
		this.cancelledRequestIds.push(requestId);
	}

	async close(): Promise<void> {
		this.currentState = "closed";
	}

	private realFixtureFor(toolName: string, args: unknown): string | null {
		if (toolName === "tabs_context" && this.options.tabsContextText) {
			return this.options.tabsContextText;
		}
		if (toolName === "get_page_text" && this.options.pageTextOutput) {
			return this.options.pageTextOutput;
		}
		if (toolName === "read_page" && this.options.pageTreeText) {
			return this.options.pageTreeText;
		}
		if (toolName === "computer" && this.options.computerResult) {
			return this.options.computerResult;
		}
		if (toolName === "form_input" && this.options.formInputResult) {
			return this.options.formInputResult;
		}
		void args;
		return null;
	}

	private fixtureFor(toolName: string): BrowserToolResult | null {
		if (toolName === "tabs.list" && this.options.tabs) {
			return createSuccessResult("Mock tabs listed.", { tabs: this.options.tabs });
		}
		if (toolName === "page.text" && this.options.pageText) {
			return createSuccessResult("Mock page text read.", { ...this.options.pageText });
		}
		if (toolName === "page.snapshot" && this.options.snapshot) {
			return createSuccessResult("Mock page snapshot created.", { ...this.options.snapshot });
		}
		if (toolName === "screenshot" && this.options.screenshot) {
			return createSuccessResult("Mock screenshot handled.", { ...this.options.screenshot });
		}
		return null;
	}

	private ensureConnected(): void {
		if (this.currentState !== "connected") {
			throw new BrowserTransportError(
				"transport_not_connected",
				"Browser transport is not connected.",
				true,
			);
		}
	}
}

function unconfiguredError(): BrowserTransportError {
	return new BrowserTransportError(
		"controller_transport_unconfigured",
		"No controller-facing transport has been configured.",
		false,
	);
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		throw new BrowserTransportError("cancelled", "Browser transport operation was cancelled.", false);
	}
}
