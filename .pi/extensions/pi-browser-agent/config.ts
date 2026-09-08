import { LocalRelayTransport } from "./local-relay-transport";
import type { BrowserTransport } from "./transport";
import { UnconfiguredBrowserTransport } from "./transport";

export type BrowserTransportMode = "local-relay" | "unconfigured";

export interface TransportConfig {
	mode: BrowserTransportMode;
	host: string;
	port: number;
	readyTimeoutMs: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** 默认中继端口（16789）：避开旧默认 16799 的常驻占用冲突，可用 PI_BROWSER_RELAY_PORT 覆盖。 */
export const RELAY_PORT_DEFAULT = 16789;
/** 浏览器扩展就绪等待默认时长（R4）。 */
export const READY_TIMEOUT_DEFAULT_MS = 8000;
/** 就绪等待硬上限（R4）。 */
export const READY_TIMEOUT_MAX_MS = 30000;

export function resolveTransportConfig(
	env: Record<string, string | undefined> = process.env,
): TransportConfig {
	const transportName = (env.PI_BROWSER_TRANSPORT ?? "local-relay").trim();
	const mode: BrowserTransportMode =
		transportName === "unconfigured"
			? "unconfigured"
			: transportName === "local-relay"
				? "local-relay"
				: (() => {
						throw new Error(
							`Invalid PI_BROWSER_TRANSPORT: "${transportName}". Use "local-relay" or "unconfigured".`,
						);
					})();

	const host = (env.PI_BROWSER_RELAY_HOST ?? "127.0.0.1").trim();
	if (!LOOPBACK_HOSTS.has(host)) {
		throw new Error(
			`PI_BROWSER_RELAY_HOST must be loopback (127.0.0.1 | localhost | ::1). Got "${host}".`,
		);
	}

	const portText = (env.PI_BROWSER_RELAY_PORT ?? String(RELAY_PORT_DEFAULT)).trim();
	if (!/^\d+$/.test(portText)) {
		throw new Error(`PI_BROWSER_RELAY_PORT must be an integer. Got "${portText}".`);
	}
	const port = Number(portText);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`PI_BROWSER_RELAY_PORT out of range (1..65535): ${portText}.`);
	}

	return { mode, host, port, readyTimeoutMs: resolveReadyTimeoutMs(env) };
}

/**
 * 就绪等待时长归一化（R4，安全归一化而非 throw）：
 * - 缺省 / 非数字 / 非整数 → 默认 8000
 * - 负数 → 0（禁用等待）
 * - 超过上限 → 30000
 */
export function resolveReadyTimeoutMs(
	env: Record<string, string | undefined> = process.env,
): number {
	const raw = (env.PI_BROWSER_READY_TIMEOUT_MS ?? "").trim();
	if (raw === "") return READY_TIMEOUT_DEFAULT_MS;
	const value = Number(raw);
	if (!Number.isFinite(value) || !Number.isInteger(value)) {
		return READY_TIMEOUT_DEFAULT_MS;
	}
	if (value < 0) return 0;
	if (value > READY_TIMEOUT_MAX_MS) return READY_TIMEOUT_MAX_MS;
	return value;
}

/**
 * 会话授权开关：仅 "1""true""yes""on" 视为开启。
 * 默认关闭（无 prompt 咨询）：无 UI 非交互中写操作默认 deny，符合安全安全默认。
 */
export function resolveSessionGrant(env: Record<string, string | undefined> = process.env): boolean {
	const value = (env.PI_BROWSER_SESSION_GRANT ?? "").toLowerCase().trim();
	return ["1", "true", "yes", "on"].includes(value);
}

export function createBrowserTransport(config: TransportConfig): BrowserTransport {
	if (config.mode === "unconfigured") {
		return new UnconfiguredBrowserTransport();
	}
	return new LocalRelayTransport({
		host: config.host,
		port: config.port,
		readyTimeoutMs: config.readyTimeoutMs,
	});
}
