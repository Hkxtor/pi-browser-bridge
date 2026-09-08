/**
 * M2 联测 runner：用 M1 handler 层（tools.ts）对真实 dev 扩展跑完整链路。
 * 不 bypass policy/audit。
 * 输出: .pi/research/browser-mapping-m2/*.json + m2-live-report.txt
 * 用法：bun run ./.pi/extensions/pi-browser-agent/m2-live-test.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ActionAudit } from "./audit";
import { createRequestContext } from "./protocol";
import type { BrowserToolResult } from "./protocol";
import {
	handleBrowserPageSnapshot,
	handleBrowserPageText,
	handleBrowserTabsList,
	handleBrowserScreenshot,
	handleElementClick,
	handleElementScroll,
} from "./tools";
import { LocalRelayTransport } from "./local-relay-transport";

const OUT = resolve(process.cwd(), ".pi/research/browser-mapping-m2");
mkdirSync(OUT, { recursive: true });

const report = resolve(process.cwd(), ".pi/research/m2-live-report.txt");
const lines: string[] = [];
function emit(line: string) {
	lines.push(`[${new Date().toISOString()}] ${line}`);
	writeFileSync(report, lines.join("\n") + "\n");
	console.log(line);
}
function save(name: string, value: unknown) {
	writeFileSync(resolve(OUT, name), JSON.stringify(value, null, 2));
}

const transport = new LocalRelayTransport({ port: 16789, host: "127.0.0.1", requestTimeoutMs: 15_000 });
const audit = new ActionAudit();

async function run() {
	emit("waiting on 127.0.0.1:16789 ...");
	await transport.connect();
	const deadline = Date.now() + 300_000;
	while (transport.state !== "connected" && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 250));
	}
	if (transport.state !== "connected") {
		emit("FAIL: no extension connected in 300s");
		process.exit(2);
	}
	emit("connected");

	const tools = await transport.discoverTools();
	emit(`discover: ${tools.length} tools (${tools.map((t) => t.name).join(", ")})`);
	save("00-discover.json", tools);

	// 1) browser_tabs_list
	const tabsCtx = createRequestContext({ requestId: "m2-tabs", sessionId: "m2" });
	const tabsRes = await handleBrowserTabsList(transport, tabsCtx);
	save("01-tabs_context.json", tabsRes.evidence);
	emit(`tabs_list: ${tabsRes.summary}`);

	type RealTab = { tabId: number; title: string; url: string; active: boolean };
	const tabs = (tabsRes.evidence as { tabs: RealTab[] }).tabs;
	const active = tabs.find((t: RealTab) => t.active) ?? tabs[0];
	const tabId = active.tabId;
	emit(`active tabId=${tabId} title=${active.title}`);

	// 2) browser_page_text
	const textRes = await handleBrowserPageText(transport, tabsCtx, { tabId });
	save("02-get_page_text.json", textRes.evidence);
	emit(`page_text: ${textRes.summary}`);

	// 3) browser_page_snapshot (read_page)
	const snapRes = await handleBrowserPageSnapshot(transport, tabsCtx, { tabId });
	save("03-read_page.json", snapRes.evidence);
	emit(`read_page: ${snapRes.summary}`);

	// 4) Deny path before allowing: no session grant, no UI
	const noGrant = { sessionGranted: false, grantedHosts: [] as string[], hasUI: false };
	const allow = { sessionGranted: true, grantedHosts: [] as string[], hasUI: false };
	type FirstRef = { ref: string; role: string };
	const refs = ((snapRes.evidence as { elements?: FirstRef[] }).elements ?? []) as FirstRef[];
	const clickRef = refs.find((r) => r.role === "link")?.ref ?? refs[0]?.ref;
	if (!clickRef) {
		emit("SKIP click: no clickable ref");
	} else {
		emit(`=== deny path ===`);
		const denyRes = await handleElementClick(
			transport,
			tabsCtx,
			{ snapshotId: "", ref: clickRef, tabId },
			noGrant,
			audit,
		).catch((e: unknown) => e);
		const denyCode = (denyRes as { code?: string }).code;
		emit(`denied click: ${denyCode}`);

		emit(`=== allow path ===`);
		const okRes = await handleElementClick(
			transport,
			tabsCtx,
			{ snapshotId: "", ref: clickRef, tabId },
			allow,
			audit,
		).catch((e: unknown) => e);
		if ((okRes as { status?: string }).status === "success") {
			emit(`allow click success (${clickRef})`);
		} else {
			emit(`allow click error: ${JSON.stringify(okRes).slice(0, 200)}`);
		}

		// 验证写副作用：重新 read_page
		const afterRes = await handleBrowserPageSnapshot(transport, tabsCtx, { tabId });
		save("04-after-click.json", afterRes.evidence);
		emit(`post-click read_page: ${afterRes.summary}`);
	}

	// 5) scroll — 用真实的 link ref（document 不是合法 ref）
	const scrollRes = await handleElementScroll(
		transport,
		tabsCtx,
		{ snapshotId: "", ref: clickRef, tabId },
		allow,
		audit,
	).catch((e: unknown) => e);
	emit(`scroll: ${(scrollRes as { status?: string }).status ?? (scrollRes as Error).message}`);

	// 6) screenshot
	const shot = await handleBrowserScreenshot(transport, tabsCtx, { tabId }).catch((e: unknown) => e);
	save("05-screenshot.json", shot as unknown);
	emit(`screenshot: ${JSON.stringify((shot as Record<string, unknown>).evidence ?? (shot as Error).message).slice(0, 160)}`);

	// 7) audit summary
	save("06-audit.json", audit.entries);
	emit(`audit entries (${audit.entries.length}):`);
	audit.entries.forEach((e, i) =>
		emit(`  ${i + 1}. action=${e.action} decision=${e.decision} result=${e.result} ref=${e.ref}`),
	);

	emit("done");
	await transport.close();
	process.exit(0);
}

run().catch((e) => {
	emit(`UNCAUGHT: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
});
