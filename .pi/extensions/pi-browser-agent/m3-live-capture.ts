/**
 * M3 联测 capture：对真实扩展做完整调用链并落证据。
 * 用法: bun run ./.pi/extensions/pi-browser-agent/m3-live-capture.ts
 * 输出：.pi/research/m3-capture/*.json + m3-live-capture-report.txt
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequestContext } from "./protocol";
import { LocalRelayTransport } from "./local-relay-transport";

const OUT = resolve(process.cwd(), ".pi/research/m3-capture");
mkdirSync(OUT, { recursive: true });

const reportLines: string[] = [];
function emit(line: string) {
	reportLines.push(`[${new Date().toISOString()}] ${line}`);
	writeFileSync(resolve(process.cwd(), ".pi/research/m3-live-capture-report.txt"), reportLines.join("\n") + "\n");
	console.log(line);
}

const transport = new LocalRelayTransport({ port: 16789, host: "127.0.0.1", requestTimeoutMs: 15_000 });

async function main() {
	emit(`waiting for extension on 127.0.0.1:16789...`);
	await transport.connect();
	const deadline = Date.now() + 300_000;
	while (transport.state !== "connected" && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 250));
	}
	if (transport.state !== "connected") {
		emit("FAIL: no extension connected within 300s");
		process.exit(2);
	}
	emit(`extension connected; transport.state=${transport.state}`);

	// --- capture extensionInfo (from client connection) ---
	logAny("client connected at", Date.now());

	// --- discover ---
	const tools = await transport.discoverTools();
	emit(`discovered ${tools.length} tools`);
	writeFileSync(resolve(OUT, "tools-discover.json"), JSON.stringify(tools, null, 2));
	for (const t of tools) {
		emit(`  - ${t.name}`);
		writeFileSync(
			resolve(OUT, `tool-${t.name}.json`),
			JSON.stringify(t, null, 2),
		);
	}

	// --- representative calls ---
	await probe("tabs_context", {});
	// 读一个真实 tab（用 tabs_context 找到示例 tab）
	try {
		const tabsRes = await run("tabs_context", {});
		const tabsPayload = (tabsRes as {tabs?: Array<{tabId?: number; windowId?: number}>}).tabs;
		const firstTab = tabsPayload?.[0];
		if (firstTab?.tabId !== undefined) {
			await probe("navigate", { url: "https://example.com", tabId: firstTab.tabId });
			await probe("get_page_text", { tabId: firstTab.tabId });
			await probe("read_page", { tabId: firstTab.tabId });
		} else {
			emit("tabs_context did not return tabId-shaped payload");
		}
	} catch (error) {
		emit(`tabs_context chain failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	emit("done");
	await transport.close();
	process.exit(0);
}

async function run(name: string, args: unknown): Promise<unknown> {
	const ctx = createRequestContext({ requestId: `live-${Date.now()}`, sessionId: "live" });
	const invoker = transport as unknown as {
		invoke(name: string, args: unknown, ctx: unknown): Promise<{ summary: string; evidence?: unknown }>;
	};
	return invoker.invoke(name, args, ctx);
}

async function probe(name: string, args: unknown) {
	emit(`-> probe ${name}`);
	try {
		const result = await run(name, args);
		emit(`  ok: ${result.summary.slice(0, 200)}`);
		writeFileSync(
			resolve(OUT, `result-${name}-${Date.now()}.json`),
			JSON.stringify(result, null, 2),
		);
	} catch (error) {
		emit(`  error: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function logAny(_label: string, _ts: number) {}

main().catch((error) => {
	emit(`UNCAUGHT: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
