/**
 * M3 完整联测（真实扩展 + 真实页面）。完成后写入 m3-live-final-report.txt。
 * 注意：需要先让 dev 扩展为此 Chrome profile 建立手动的 Pi 授权策略。
 * 联测策略：读不做 confirm；写操作通过 audit 测允许为先（session grant 在 live-smoke 里直接绕过 policy 层）。
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequestContext } from "./protocol";
import { LocalRelayTransport } from "./local-relay-transport";

const OUT = resolve(process.cwd(), ".pi/research/m3-capture");
mkdirSync(OUT, { recursive: true });

const report = resolve(process.cwd(), ".pi/research/m3-live-final-report.txt");
const lines: string[] = [];
function emit(line: string) {
	lines.push(`[${new Date().toISOString()}] ${line}`);
	writeFileSync(report, lines.join("\n") + "\n");
	console.log(line);
}

const transport = new LocalRelayTransport({ port: 16789, host: "127.0.0.1", requestTimeoutMs: 15_000 });

async function invoke(name: string, args: Record<string, unknown>) {
	const ctx = createRequestContext({ requestId: `live-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`, sessionId: "live" });
	const invoker = transport as unknown as {
		invoke(name: string, args: unknown, ctx: unknown): Promise<{ summary: string; evidence?: unknown }>;
	};
	return invoker.invoke(name, args, ctx);
}

async function main() {
	emit(`waiting on 127.0.0.1:16789 ...`);
	await transport.connect();

	const deadline = Date.now() + 300_000;
	while (transport.state !== "connected" && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 250));
	}
	if (transport.state !== "connected") {
		emit("FAIL: no extension connected in 300s");
		process.exit(2);
	}
	emit("extension connected");

	// 0. discover tools
	const tools = await transport.discoverTools();
	emit(`discover: ${tools.length} tools`);
	if (!readFileSync) throw new Error("readFileSync unavailable");

	// 1. tabs_context
	const tabsCtx = await invoke("tabs_context", {});
	emit(`tabs_context: ${tabsCtx.summary}`);
	writeFileSync(resolve(OUT, "01-tabs_context.json"), JSON.stringify(tabsCtx.evidence, null, 2));

	// parse the tab id from the evidence
	const evidenceText = JSON.stringify(tabsCtx.evidence);
	const tabIdMatch = evidenceText.match(/\[(\d+)\]/);
	const tabId = tabIdMatch ? Number(tabIdMatch[1]) : undefined;
	if (tabId === undefined) {
		emit(`FAIL: could not parse tabId from tabs_context evidence`);
		process.exit(3);
	}
	emit(`tabId=${tabId}`);

	// 2. navigate (a write op on extension, though it simply changes tab)
	await invoke("navigate", { url: "https://example.com", tabId });
	emit("navigate ok");

	// 3. get_page_text（真实工具的 schema 不支持 maxChars，只用 tabId）
	const text = await invoke("get_page_text", { tabId });
	emit(`get_page_text: summary=${text.summary.slice(0, 120)}`);
	writeFileSync(resolve(OUT, "02-get_page_text.json"), JSON.stringify(text.evidence, null, 2));

	// 4. read_page (HTML-like semantic view)
	const readPage = await invoke("read_page", { tabId });
	emit(`read_page: summary=${readPage.summary.slice(0, 120)}`);
	writeFileSync(resolve(OUT, "03-read_page.json"), JSON.stringify(readPage.evidence, null, 2));

	// 5. read_console_messages (dev-only tool; observe)
	const consoleMsgs = await invoke("read_console_messages", { tabId });
	emit(`read_console_messages summary=${consoleMsgs.summary.slice(0, 120)}`);
	writeFileSync(resolve(OUT, "04-read_console_messages.json"), JSON.stringify(consoleMsgs.evidence, null, 2));

	// 6. read_network_requests (dev-only tool; observe)
	const network = await invoke("read_network_requests", { tabId });
	emit(`read_network_requests summary=${network.summary.slice(0, 120)}`);
	writeFileSync(resolve(OUT, "05-read_network_requests.json"), JSON.stringify(network.evidence, null, 2));

	// 7. find (real snapshot; searching for a DOM element)
	try {
		const findRes = await invoke("find", { tabId, query: "Example Domain" });
		emit(`find: summary=${findRes.summary.slice(0, 160)}`);
		writeFileSync(resolve(OUT, "06-find.json"), JSON.stringify(findRes.evidence, null, 2));
	} catch (e) {
		emit(`find error: ${e instanceof Error ? e.message : String(e)}`);
	}

	// 8. screenshot （写 action 于 extension 内部，Pi 侧不动 policy）
	try {
		const shot = await invoke("computer", { action: "screenshot", tabId });
		emit(`computer(screenshot) summary=${shot.summary.slice(0, 120)}`);
		writeFileSync(resolve(OUT, "07-screenshot.json"), JSON.stringify(shot.evidence, null, 2));
	} catch (e) {
		emit(`computer(screenshot) error: ${e instanceof Error ? e.message : String(e)}`);
	}

	// 9. cancel path (invoke with pre-aborted signal — transport should return cancelled)
	const ctx = createRequestContext({ requestId: "live-cancel", sessionId: "live" });
	const controller = new AbortController();
	controller.abort();
	try {
		const invoker = transport as unknown as {
			invoke(name: string, args: unknown, ctx: unknown, signal?: AbortSignal): Promise<{ summary: string }>;
		};
		await invoker.invoke("get_page_text", { tabId }, ctx, controller.signal);
		emit("cancel test: no error (unexpected)");
	} catch (e) {
		const code = (e as { code?: string }).code ?? "unknown";
		emit(`cancel test: code=${code}`);
	}

	emit("done");
	await transport.close();
	process.exit(0);
}

main().catch((e) => {
	emit(`UNCAUGHT: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
});
