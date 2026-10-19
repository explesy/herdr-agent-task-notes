// Herdr CLI + Unix socket helpers: snapshot, metadata reporting, agent view sorting,
// and live focus/status event subscription.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const PLUGIN_ID = process.env.HERDR_PLUGIN_ID ?? "explesy.agent-task-notes";
export const SOURCE = "plugin:task-notes";
export const BOTTOM_TOKENS = [
	"b_sep",
	"b_top",
	"b_meta",
	"b_t1",
	"b_t2",
	"b_t3",
	"b_t4",
	"b_t5",
	"b_n1",
	"b_n2",
	"b_n3",
	"b_n4",
	"b_n5",
	"b_n6",
];
export const LEGACY_TOKENS = ["b_pin", "b_n7", "b_hdr", "b_tl", "b_nl", "task", "now", "summary"];
export const TOKENS = BOTTOM_TOKENS;

export function herdrBin() {
	return process.env.HERDR_BIN_PATH ?? "herdr";
}

export function socketPath() {
	if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
	return path.join(os.homedir(), ".config", "herdr", "herdr.sock");
}

export function snapshot() {
	const r = spawnSync(herdrBin(), ["api", "snapshot"], { encoding: "utf8", timeout: 5000 });
	if (r.status !== 0 || !r.stdout) return undefined;
	try {
		return JSON.parse(r.stdout)?.result?.snapshot;
	} catch {
		return undefined;
	}
}

function run(args) {
	const r = spawnSync(herdrBin(), args, { encoding: "utf8", timeout: 5000 });
	return r.status === 0;
}

export function reportMetadata(paneId, tokens, seq, ttlMs) {
	const args = ["pane", "report-metadata", paneId, "--source", SOURCE, "--seq", String(seq)];
	if (ttlMs) args.push("--ttl-ms", String(ttlMs));
	const setNames = new Set();
	for (const [name, value] of Object.entries(tokens ?? {})) {
		if (value) {
			args.push("--token", `${name}=${value}`);
			setNames.add(name);
		}
	}
	for (const name of BOTTOM_TOKENS) {
		if (!setNames.has(name)) {
			args.push("--clear-token", name);
		}
	}
	return run(args);
}

export function clearMetadata(paneId, seq, includeLegacy = false) {
	const args = ["pane", "report-metadata", paneId, "--source", SOURCE, "--seq", String(seq)];
	for (const name of BOTTOM_TOKENS) args.push("--clear-token", name);
	const ok = run(args);
	if (includeLegacy) {
		const legacyArgs = ["pane", "report-metadata", paneId, "--source", SOURCE, "--seq", String(seq + 1)];
		for (const name of LEGACY_TOKENS) legacyArgs.push("--clear-token", name);
		run(legacyArgs);
	}
	return ok;
}

function socketRequest(method, params) {
	return new Promise((resolve) => {
		const sp = socketPath();
		if (process.platform !== "win32" && !fs.existsSync(sp)) {
			resolve(undefined);
			return;
		}
		const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${sp}` : sp;
		const sock = net.createConnection(endpoint);
		let buf = "";
		let settled = false;
		const finish = (val) => {
			if (settled) return;
			settled = true;
			try {
				sock.destroy();
			} catch {
				// Ignore
			}
			resolve(val);
		};
		const timer = setTimeout(() => finish(undefined), 1500);
		timer.unref?.();

		sock.on("connect", () => {
			const req = {
				id: `${SOURCE}:${method}:${Date.now()}`,
				method,
				params,
			};
			sock.write(`${JSON.stringify(req)}\n`);
		});
		sock.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			const nl = buf.indexOf("\n");
			if (nl >= 0) {
				clearTimeout(timer);
				try {
					finish(JSON.parse(buf.slice(0, nl)));
				} catch {
					finish(undefined);
				}
			}
		});
		sock.on("error", () => {
			clearTimeout(timer);
			finish(undefined);
		});
	});
}

export async function clearAgentView(pluginId = PLUGIN_ID) {
	return socketRequest("agent.view.clear", {
		source: pluginId,
	});
}

/**
 * Subscribes to Herdr focus & status events on the Unix socket so that switching
 * workspaces, tabs, or panes triggers an immediate sidebar refresh (<30ms).
 * Automatically reconnects if the socket drops.
 */
export function subscribeEvents(onEvent, onLog = () => {}) {
	let destroyed = false;
	let sock = null;
	let retryTimer = null;

	const connect = () => {
		if (destroyed) return;
		const sp = socketPath();
		if (process.platform !== "win32" && !fs.existsSync(sp)) {
			retryTimer = setTimeout(connect, 2000);
			retryTimer.unref?.();
			return;
		}
		const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${sp}` : sp;
		sock = net.createConnection(endpoint);
		let buf = "";

		sock.on("connect", () => {
			const req = {
				id: `${SOURCE}:sub:${Date.now()}`,
				method: "events.subscribe",
				params: {
					subscriptions: [
						{ type: "workspace.focused" },
						{ type: "workspace.closed" },
						{ type: "workspace.reordered" },
						{ type: "tab.focused" },
						{ type: "tab.closed" },
						{ type: "pane.focused" },
						{ type: "pane.closed" },
						{ type: "pane.agent_detected" },
					],
				},
			};
			sock.write(`${JSON.stringify(req)}\n`);
		});

		sock.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			let nl;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line) continue;
				try {
					const msg = JSON.parse(line);
					if (msg?.type === "subscription_event" || msg?.event) {
						onEvent(msg.event ?? msg);
					}
				} catch {
					// Ignore malformed lines
				}
			}
		});

		const scheduleReconnect = () => {
			if (destroyed) return;
			try {
				sock?.destroy();
			} catch {
				// Ignore
			}
			sock = null;
			if (!retryTimer) {
				retryTimer = setTimeout(() => {
					retryTimer = null;
					connect();
				}, 2000);
				retryTimer.unref?.();
			}
		};

		sock.on("error", (err) => {
			onLog(`socket error: ${err?.message ?? err}`);
			scheduleReconnect();
		});
		sock.on("close", scheduleReconnect);
	};

	connect();

	return () => {
		destroyed = true;
		if (retryTimer) clearTimeout(retryTimer);
		try {
			sock?.destroy();
		} catch {
			// Ignore
		}
	};
}
