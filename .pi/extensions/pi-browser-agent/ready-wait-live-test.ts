/**
 * pi-browser-ready-wait M2 联测 runner（观测脚本，不是测试）。
 * 对真实 dev Chrome 扩展验证 M1 就绪等待行为。
 *
 * 用法：bun run ./.pi/extensions/pi-browser-agent/ready-wait-live-test.ts <scenario>
 *   success  —— 冷启动成功路径：runner 起 listen 后调 browser_tabs_list，
 *               人工在 readyTimeoutMs 窗口内启动 dev 扩展 → 预期成功且只发一次 tools/invoke
 *   timeout  —— 扩展不启动 → 预期 browser_not_ready（retryable，无裸 client_not_connected）
 *   disabled —— PI_BROWSER_READY_TIMEOUT_MS=0 → 预期立即 client_not_connected
 *
 * 输出：.pi/research/browser-ready-wait/{scenario}.json + ready-wait-live-report.txt
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequestContext } from "./protocol";
import { BrowserTransportError } from "./protocol";
import { resolveReadyTimeoutMs } from "./config";
import { handleBrowserTabsList } from "./tools";
import { LocalRelayTransport } from "./local-relay-transport";

type Scenario = "success" | "timeout" | "disabled";

const scenario = process.argv[2] as Scenario | undefined;
if (!scenario || !["success", "timeout", "disabled"].includes(scenario)) {
	console.error("usage: bun run ready-wait-live-test.ts <success|timeout|disabled>");
	process.exit(2);
}

const OUT = resolve(process.cwd(), ".pi/research/browser-ready-wait");
mkdirSync(OUT, { recursive: true });
const reportPath = resolve(OUT, "ready-wait-live-report.txt");
const lines: string[] = [];
function emit(line: string) {
	lines.push(`[${new Date().toISOString()}] [${scenario}] ${line}`);
	writeFileSync(reportPath, lines.join("\n") + "\n");
	console.log(`[${scenario}] ${line}`);
}

const port = Number(process.env.PI_BROWSER_RELAY_PORT ?? 16789);
const readyTimeoutMs = resolveReadyTimeoutMs(process.env);
const transport = new LocalRelayTransport({ port, host: "127.0.0.1", requestTimeoutMs: 15_000, readyTimeoutMs });

// 统计 tools/invoke 发送次数：验证“只发一次”
let invokeSends = 0;
const origRequest = (transport as unknown as { request: (...a: unknown[]) => Promise<unknown> }).request.bind(transport);
(transport as unknown as { request: (...a: unknown[]) => Promise<unknown> }).request = (...args: unknown[]) => {
	if (args[0] === "tools/invoke") invokeSends++;
	return origRequest(...args);
};

emit(`readyTimeoutMs=${readyTimeoutMs} (env=${process.env.PI_BROWSER_READY_TIMEOUT_MS ?? "<unset>"}) port=${port}`);

const startedAt = Date.now();
const ctx = createRequestContext({ requestId: `m2-${scenario}`, sessionId: "live-m2" });

async function main() {
	try {
		const result = await handleBrowserTabsList(transport, ctx, {});
		const elapsedMs = Date.now() - startedAt;
		const tabs = (result.evidence as { tabs?: unknown[] } | undefined)?.tabs;
		emit(`RESULT status=${result.status} elapsedMs=${elapsedMs} invokeSends=${invokeSends} tabs=${tabs?.length ?? "?"}`);
		emit(`summary: ${result.summary}`);
		writeFileSync(
			resolve(OUT, `${scenario}.json`),
			JSON.stringify(
				{
					scenario,
					outcome: "success",
					elapsedMs,
					invokeSends,
					readyTimeoutMs,
					state: transport.state,
					summary: result.summary,
					tabsCount: tabs?.length ?? null,
				},
				null,
				2,
			),
		);
		if (scenario === "timeout" || scenario === "disabled") {
			emit("UNEXPECTED: expected failure but got success");
			process.exitCode = 3;
		} else if (invokeSends !== 1) {
			emit(`FAIL: expected exactly 1 tools/invoke send, got ${invokeSends}`);
			process.exitCode = 4;
		}
	} catch (error) {
		const elapsedMs = Date.now() - startedAt;
		const code = error instanceof BrowserTransportError ? error.code : "internal_error";
		const retryable = error instanceof BrowserTransportError ? error.retryable : false;
		const details = error instanceof BrowserTransportError ? error.details : undefined;
		emit(`RESULT error code=${code} retryable=${retryable} elapsedMs=${elapsedMs} invokeSends=${invokeSends}`);
		emit(`message: ${error instanceof Error ? error.message : String(error)}`);
		writeFileSync(
			resolve(OUT, `${scenario}.json`),
			JSON.stringify(
				{
					scenario,
					outcome: "error",
					elapsedMs,
					invokeSends,
					readyTimeoutMs,
					state: transport.state,
					error: { code, retryable, details, message: error instanceof Error ? error.message : String(error) },
				},
				null,
				2,
			),
		);
		if (scenario === "success") {
			emit("FAIL: expected success within the ready window");
			process.exitCode = 5;
		} else if (scenario === "timeout" && code !== "browser_not_ready") {
			emit(`FAIL: expected browser_not_ready, got ${code}`);
			process.exitCode = 6;
		} else if (scenario === "disabled" && code !== "client_not_connected") {
			emit(`FAIL: expected client_not_connected, got ${code}`);
			process.exitCode = 7;
		}
	} finally {
		await transport.close();
		emit(`closed; final state=${transport.state}`);
	}
}

await main();
