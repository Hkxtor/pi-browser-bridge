import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

/**
 * 零依赖最小 RFC6455 服务端（loopback、text frame、无 TLS、无子协议）。
 * 只服务 Pi ↔ Chrome 扩展的本地 JSON 消息；不暴露给非本机地址。
 */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEBUG = process.env.PI_WS_DEBUG === "1";
function debug(...args: unknown[]): void {
	if (DEBUG) console.error("[minimal-ws]", ...args);
}

export interface MinimalWsConnection {
	readonly id: string;
	readonly path: string;
	sendText(text: string): void;
	close(code?: number, reason?: string): void;
	readonly closed: boolean;
}

export interface MinimalWsServer {
	readonly port: number;
	close(): Promise<void>;
}

export interface MinimalWsServerHandlers {
	onConnection(conn: MinimalWsConnection): void;
	onMessage(conn: MinimalWsConnection, text: string): void;
	onClose(conn: MinimalWsConnection): void;
}

export interface MinimalWsServerOptions {
	host: string;
	port: number;
	path: string;
	appInfo?: Readonly<Record<string, unknown>>;
}

export function startMinimalWsServer(
	options: MinimalWsServerOptions,
	handlers: MinimalWsServerHandlers,
): Promise<MinimalWsServer> {
	const sockets = new Set<Socket>();

	const server: Server = createServer((socket) => {
		sockets.add(socket);
		debug("socket open from", socket.remoteAddress, socket.remotePort);
		// 防止 ECONNRESET/其它生命周期错误导致未捕获异常（probe/手動断连正常）
		socket.on("error", (err) => {
			debug("socket error:", (err as NodeJS.ErrnoException).code ?? err.message);
		});
		socket.on("close", () => sockets.delete(socket));
		handleUpgrade(socket, options, handlers);
	});
	server.on("error", () => {
		/* 启动阶段 node 用了 promise 的 reject; listen 后的运行期错误不重要，忽略 */
	});

	return new Promise((resolve, reject) => {
		server.on("error", reject);
		server.listen(options.port, options.host, () => {
			const address = server.address();
			if (typeof address !== "object" || address === null) {
				reject(new Error("minimal ws server bound without an address"));
				return;
			}
			resolve({
				port: address.port,
				close: () =>
					new Promise<void>((resolveClose) => {
						for (const socket of sockets) socket.destroy();
						server.close(() => resolveClose());
					}),
			});
		});
	});
}

function handleUpgrade(
	socket: Socket,
	options: MinimalWsServerOptions,
	handlers: MinimalWsServerHandlers,
): void {
	let buffer = Buffer.alloc(0);

	const failBadRequest = () => {
		try {
			// 不 destroy：book书正常情况下应该收到一个完整 HTTP 响应 + FIN，
			// 否则扩展的端口探测（fetch HEAD no-cors）为 reset/拒绝会误判不可用。
			socket.write(
				"HTTP/1.1 426 Upgrade Required\r\nUpgrade: websocket\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
				() => socket.end(),
			);
		} catch {
			try {
				socket.destroy();
			} catch {
				/* ignore */
			}
		}
	};

	const onData = (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		debug("socket bytes:", buffer.slice(0, 120).toString("latin1").replace(/\r/g, "\\r").replace(/\n/g, "\\n"));
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd < 0) {
			if (buffer.length > 16 * 1024) failBadRequest();
			return;
		}

		socket.removeListener("data", onData);
		const headerText = buffer.subarray(0, headerEnd).toString("latin1");
		const lines = headerText.split("\r\n");
		const [requestLine, ...headerLines] = lines;
		const methodMatch = /^(GET|HEAD|OPTIONS)\s+(\S+)\s+HTTP\/1\.1$/i.exec(requestLine ?? "");
		if (!methodMatch) {
			failBadRequest();
			return;
		}
		const [, method, rawPath] = methodMatch;
		const path = rawPath.split("?")[0];
		debug("http request", method, path);
		const headers = new Map<string, string>();
		for (const line of headerLines) {
			const idx = line.indexOf(":");
			if (idx > 0) headers.set(line.slice(0, idx).trim().toLowerCase(), line.slice(idx + 1).trim());
		}
		if (method === "GET" && path === "/app/info" && options.appInfo) {
			const body = JSON.stringify(options.appInfo);
			try {
				socket.write(
					`HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
					() => socket.end(),
				);
			} catch {
				socket.destroy();
			}
			return;
		}
		// 扩展端口探测是 `fetch HEAD no-cors`：回 200 让探测具备依书读。
		if (method === "HEAD" || method === "OPTIONS") {
			try {
				socket.write("HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", () => socket.end());
			} catch {
				socket.destroy();
			}
			return;
		}
		const upgrade = (headers.get("upgrade") ?? "").toLowerCase();
		const key = headers.get("sec-websocket-key");
		if (path !== options.path || upgrade !== "websocket" || !key) {
			failBadRequest();
			return;
		}

		debug("ws handshake accepted for", path);
		const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
		);

		const conn = buildConnection(socket, path, handlers);
		handlers.onConnection(conn);
		const rest = buffer.subarray(headerEnd + 4);
		if (rest.length > 0) connFeed(conn, rest);
		socket.on("data", (chunk) => connFeed(conn, chunk));
		socket.on("close", () => {
			connMarkClosed(conn);
			handlers.onClose(conn);
		});
	};

	socket.on("data", onData);
}

interface ConnState {
	buffer: Buffer;
	fragmented: Buffer | null;
	closed: boolean;
	socket: Socket;
	path: string;
	id: string;
	onMessage: (conn: MinimalWsConnection, text: string) => void;
	self: MinimalWsConnection;
}

function buildConnection(
	socket: Socket,
	path: string,
	handlers: MinimalWsServerHandlers,
): MinimalWsConnection & { __state?: ConnState } {
	const state: ConnState = {
		buffer: Buffer.alloc(0),
		fragmented: null,
		closed: false,
		socket,
		path,
		id: randomBytes(8).toString("hex"),
		onMessage: handlers.onMessage,
		self: null as unknown as MinimalWsConnection,
	};

	const conn: MinimalWsConnection & { __state?: ConnState } = {
		id: state.id,
		path,
		get closed() {
			return state.closed;
		},
		sendText(text: string) {
			if (state.closed) return;
			const payload = Buffer.from(text, "utf8");
			const frame = encodeFrame(0x1, payload);
			socket.write(frame);
		},
		close(code = 1000, reason = "bye") {
			if (state.closed) return;
			state.closed = true;
			try {
				const reasonBuf = Buffer.from(reason, "utf8");
				const payload = Buffer.concat([Buffer.from([(code >> 8) & 0xff, code & 0xff]), reasonBuf]);
				socket.write(encodeFrame(0x8, payload));
			} catch {
				/* ignore */
			}
			socket.end();
		},
		__state: state,
	};
	state.self = conn;
	return conn;
}

function connState(conn: MinimalWsConnection): ConnState {
	const state = (conn as { __state?: ConnState }).__state;
	if (!state) throw new Error("minimal ws connection missing state");
	return state;
}

function connMarkClosed(conn: MinimalWsConnection): void {
	connState(conn).closed = true;
}

function connFeed(conn: MinimalWsConnection, chunk: Buffer): void {
	const state = connState(conn);
	state.buffer = Buffer.concat([state.buffer, chunk]);

	for (;;) {
		const frame = tryParseFrame(state.buffer);
		if (!frame) return;
		state.buffer = state.buffer.subarray(frame.consumed);

		const { opcode, fin, payload } = frame;
		if (opcode === 0x8) {
			// close
			state.closed = true;
			try {
				state.socket.write(encodeFrame(0x8, payload.subarray(0, 125)));
			} catch {
				/* ignore */
			}
			state.socket.end();
			return;
		}
		if (opcode === 0x9) {
			// ping → pong
			try {
				state.socket.write(encodeFrame(0xA, payload));
			} catch {
				/* ignore */
			}
			continue;
		}
		if (opcode === 0xA) {
			continue; // pong：本实现不做心跳超时检查
		}

		// data frames：0x1 text / 0x2 binary 均按 utf8 text 处理（协议帧只有文本）
		if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
			if (fin) {
				const whole =
					state.fragmented && opcode === 0x0
						? Buffer.concat([state.fragmented, payload])
						: state.fragmented
							? Buffer.concat([state.fragmented, payload])
							: payload;
				state.fragmented = null;
				state.onMessage(state.self, whole.toString("utf8"));
			} else {
				state.fragmented = state.fragmented
					? Buffer.concat([state.fragmented, payload])
					: Buffer.from(payload);
			}
		}
	}
}

interface ParsedFrame {
	opcode: number;
	fin: boolean;
	payload: Buffer;
	consumed: number;
}

function tryParseFrame(buffer: Buffer): ParsedFrame | null {
	if (buffer.length < 2) return null;
	const b0 = buffer[0];
	const b1 = buffer[1];
	const fin = (b0 & 0x80) !== 0;
	const opcode = b0 & 0x0f;
	const masked = (b1 & 0x80) !== 0;
	let length = b1 & 0x7f;
	let offset = 2;

	if (length === 126) {
		if (buffer.length < offset + 2) return null;
		length = buffer.readUInt16BE(offset);
		offset += 2;
	} else if (length === 127) {
		if (buffer.length < offset + 8) return null;
		const big = buffer.readBigUInt64BE(offset);
		length = Number(big);
		offset += 8;
	}

	let maskKey: Buffer | null = null;
	if (masked) {
		if (buffer.length < offset + 4) return null;
		maskKey = buffer.subarray(offset, offset + 4);
		offset += 4;
	}

	if (buffer.length < offset + length) return null;
	let payload = Buffer.from(buffer.subarray(offset, offset + length));
	if (maskKey) {
		for (let i = 0; i < payload.length; i++) {
			payload[i] ^= maskKey[i % 4];
		}
	}
	return { opcode, fin, payload, consumed: offset + length };
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
	const fin = 0x80;
	const length = payload.length;
	let header: Buffer;
	if (length < 126) {
		header = Buffer.from([fin | opcode, length]);
	} else if (length < 65536) {
		header = Buffer.alloc(4);
		header[0] = fin | opcode;
		header[1] = 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = fin | opcode;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(length), 2);
	}
	return Buffer.concat([header, payload]);
}
