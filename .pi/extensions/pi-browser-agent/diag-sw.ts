/**
 * CDP 诊断脚本：连接 extension Service Worker，输出 globalThis 上的可疑状态和日志监听。
 * 用法: bun run ./.pi/extensions/pi-browser-agent/diag-sw.ts
 */
const CDP_HTTP = "http://127.0.0.1:9222";

interface CdpTarget {
	id: string;
	type: string;
	url: string;
	webSocketDebuggerUrl?: string;
}

async function rpc(ws: WebSocket, id: number, method: string, params: unknown) {
	return new Promise<Record<string, unknown>>((resolve, reject) => {
		const onMessage = (ev: MessageEvent) => {
			try {
				const msg = JSON.parse(String(ev.data));
				if (msg.id === id) {
					ws.removeEventListener("message", onMessage);
					msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
				}
			} catch {}
		};
		ws.addEventListener("message", onMessage);
		ws.send(JSON.stringify({ id, method, params }));
	});
}

async function evaluateSW(ws: WebSocket, expression: string) {
	let id = 1;
	const r = await rpc(ws, id++, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	const rObj = (r as { result?: { value?: unknown; description?: string } }).result;
	return rObj?.value ?? rObj?.description ?? "(no result)";
}

const targets = (await (await fetch(`${CDP_HTTP}/json`)).json()) as CdpTarget[];
const swTargets = targets.filter((t) => t.type === "service_worker" && t.url.includes("background.js"));
console.log(`found ${swTargets.length} extension SW(s)`);

for (const target of swTargets) {
	const ws = new WebSocket(target.webSocketDebuggerUrl!);
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error("ws open failed"));
	});

	const idMatch = target.url.match(/chrome-extension:\/\/([a-z]+)\//);
	console.log(`\n=== SW ${idMatch?.[1]} ===`);

	// 1. globalThis keys
	const keysResult = await evaluateSW(
		ws,
		`Object.getOwnPropertyNames(globalThis).filter(k => /relay|watcher|state|browser|version|bridge|client/i.test(k)).slice(0, 50)`,
	);
	console.log("global keys:", JSON.stringify(keysResult));

	// 2. 试试常见状态对象
	for (const name of ["__piBrowserState", "__piBrowserBridge", "state", "w"]) {
		const val = await evaluateSW(
			ws,
			`(() => { try { const o = globalThis[${JSON.stringify(name)}]; return o ? Object.keys(o).slice(0, 30) : null } catch (e) { return String(e) } })()`,
		);
		if (val && (!Array.isArray(val) || val.length > 0)) console.log(`globalThis.${name}:`, JSON.stringify(val));
	}

	// 3. WebSocket 主动尝试连接 16799 和 16789 看扩展侧能不能走
	for (const port of [16799, 16789]) {
		const probe = await evaluateSW(
			ws,
			`new Promise(res => { const s = new WebSocket('ws://127.0.0.1:${port}/extension/v2'); const t = setTimeout(() => res({ port: ${port}, state: 'timeout', rs: s.readyState }), 2000); s.onopen = () => { clearTimeout(t); res({ port: ${port}, state: 'open' }); s.close(); }; s.onerror = (e) => { clearTimeout(t); res({ port: ${port}, state: 'error' }); }; })`,
		);
		console.log(`probe 127.0.0.1:${port}`, JSON.stringify(probe));
	}

	ws.close();
}
