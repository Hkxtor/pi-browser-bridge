/**
 * M3 联测 runner（不是测试；是真实联测的观测脚本）。
 * 监听 16789，等待真实 Chrome 扩展连接，dump 握手与 discover 结果后退出。
 * 用法: bun run ./.pi/extensions/pi-browser-agent/live-smoke.ts
 */
import { createRequestContext } from "./protocol";
import { LocalRelayTransport } from "./local-relay-transport";

const port = Number(process.env.PI_BROWSER_RELAY_PORT ?? 16789);
const transport = new LocalRelayTransport({ port, host: "127.0.0.1", requestTimeoutMs: 10_000 });

console.log(`[live-smoke] listening on 127.0.0.1:${port}, waiting for the real extension...`);
await transport.connect();

const deadline = Date.now() + 90_000;
while (transport.state !== "connected" && Date.now() < deadline) {
	await new Promise((r) => setTimeout(r, 250));
}

if (transport.state !== "connected") {
	console.error("[live-smoke] FAIL: no extension connected within 90s");
	process.exit(2);
}
console.log("[live-smoke] extension connected");

const tools = await transport.discoverTools();
console.log(`[live-smoke] discover returned ${tools.length} tools`);
for (const t of tools) {
	console.log(`  - ${t.name} (${t.description?.length ?? 0} chars desc)`);
}

const ctx = createRequestContext({ requestId: "live-1", sessionId: "live" });
try {
	const anyTransport = transport as unknown as { invoke(name: string, args: unknown, ctx: unknown): Promise<unknown> };
	const result = (await anyTransport.invoke("list_tabs", {}, ctx)) as { summary: string; evidence?: unknown };
	console.log("[live-smoke] list_tabs result:", result.summary);
} catch (error) {
	console.error("[live-smoke] list_tabs failed:", error instanceof Error ? error.message : String(error));
}

await transport.close();
console.log("[live-smoke] done");
