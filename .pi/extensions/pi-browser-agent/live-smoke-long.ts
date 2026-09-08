/**
 * M3 联测 runner（长存活版本）：监听 16789，收到扩展连接后跑 discover+只读工具的联测探针。
 * 写入报告文件而不是 stdout——在 ctx_batch_execute 中能读到运行状态。
 * 用法: Start-Process bun -ArgumentList run,live-smoke-long.ts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequestContext } from "./protocol";
import { LocalRelayTransport } from "./local-relay-transport";

const REPORT = resolve(process.cwd(), ".pi/research/m3-live-smoke-report.txt");
const lines: string[] = [];
function emit(line: string) {
	lines.push(`[${new Date().toISOString()}] ${line}`);
	writeFileSync(REPORT, lines.join("\n") + "\n");
	console.log(line);
}

main().catch((error) => {
	emit(`UNCAUGHT: ${error instanceof Error ? error.message : String(error)}`);
	writeFileSync(REPORT, lines.join("\n") + "\n");
	process.exit(1);
});

async function main() {
	emit(`listening on 127.0.0.1:16789 (waiting for dev extension)`);
	const transport = new LocalRelayTransport({ port: 16789, host: "127.0.0.1", requestTimeoutMs: 10_000 });
	await transport.connect();

	// 无上限等待扩展；但我们侧写入的报告让 pi 可以随时看状态
	const deadline = Date.now() + 300_000;
	while (transport.state !== "connected" && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 250));
	}
	if (transport.state !== "connected") {
		emit("FAIL: no extension connected within 300s");
		process.exit(2);
	}
	emit("extension connected");

	const tools = await transport.discoverTools();
	emit(`discover returned ${tools.length} tools`);
	for (const t of tools) {
		emit(`  tool: ${t.name}`);
	}

	const ctx = createRequestContext({ requestId: "live-1", sessionId: "live" });
	for (const name of ["list_tabs", "get_page_text"]) {
		try {
			const invoker = transport as unknown as {
				invoke(name: string, args: unknown, ctx: unknown): Promise<{ summary: string; evidence?: unknown }>;
			};
			const result = await invoker.invoke(name, name === "get_page_text" ? { tabId: 1 } : {}, ctx);
			emit(`${name} -> ok. summary=${result.summary}`);
		} catch (error) {
			emit(`${name} -> ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	emit("done");
	process.exit(0);
}
