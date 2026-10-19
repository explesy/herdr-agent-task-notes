#!/usr/bin/env node
// Keeps the agent list in Herdr's sidebar compact (2 rows per agent) and renders
// a live multi-line summary block BELOW the agent list for the currently focused
// agent tab (hidden when switching to a tab without an agent).
//
// Click-safety: Herdr associates each agent's rendered rows (including custom
// token rows) with that agent's `pane_id` hit rect. By attaching the summary
// tokens directly to `focusedAgent.pane_id` and using `agent.view.set` (`b_pin`
// token sort) to keep the focused agent at the bottom of the list, clicking the
// summary text targets the already-focused pane and never switches tabs/panes.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { activityFor, screenActivity } from "../lib/adapters.mjs";
import { ensureSidebarConfig, removeSidebarConfig } from "../lib/config.mjs";
import { cleanTerminalTitle, clip, wrapLines } from "../lib/format.mjs";
import {
	clearAgentView,
	clearMetadata,
	PLUGIN_ID,
	reportMetadata,
	setAgentView,
	snapshot,
	SOURCE,
	subscribeEvents,
} from "../lib/herdr.mjs";

const STATE_DIR = process.env.HERDR_PLUGIN_STATE_DIR ?? path.join(os.homedir(), ".local", "state", "herdr-task-notes");
const PID_FILE = path.join(STATE_DIR, "daemon.pid");
const LOG_FILE = path.join(STATE_DIR, "daemon.log");
const INTERVAL_MS = Math.max(500, Number(process.env.TASK_NOTES_INTERVAL_MS ?? 1500));
const LINE_WIDTH = Math.max(14, Number(process.env.TASK_NOTES_WIDTH ?? 22));

function log(...parts) {
	try {
		fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${parts.join(" ")}\n`);
	} catch {
		// Logging must never break the poller.
	}
}

function pidAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readPid() {
	try {
		const pid = Number(fs.readFileSync(PID_FILE, "utf8").trim());
		return pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------- core

function computeAvailableBottomRows(snap) {
	const panes = snap?.panes ?? [];
	const viewportRows = Math.max(30, ...panes.map((p) => Number(p?.scroll?.viewport_rows ?? 0)));
	const detailHeight = Math.floor(viewportRows / 2);
	const bodyHeight = Math.max(0, detailHeight - 3);
	const agentCount = (snap?.agents ?? []).length;
	return Math.max(0, bodyHeight - agentCount * 2);
}

function resolveFocusedInfo(snap) {
	const workspaces = new Map((snap.workspaces ?? []).map((w) => [w.workspace_id, w]));
	const tabs = new Map((snap.tabs ?? []).map((t) => [t.tab_id, t]));
	const agents = snap.agents ?? [];
	const panes = snap.panes ?? [];

	let focusedAgent = agents.find((a) => a.focused);
	const focusedPane = panes.find((p) => p.focused);

	if (!focusedAgent && focusedPane) {
		focusedAgent =
			agents.find((a) => a.pane_id === focusedPane.pane_id) ??
			agents.find((a) => a.tab_id === focusedPane.tab_id);
	}

	// Do not display anything for tabs without an agent.
	if (!focusedAgent) return undefined;

	const ws = workspaces.get(focusedAgent.workspace_id) ?? (snap.workspaces ?? []).find((w) => w.focused);
	const tab = tabs.get(focusedAgent.tab_id) ?? (snap.tabs ?? []).find((t) => t.focused);
	const wsLabel = ws?.label ?? focusedAgent.workspace_id ?? "pane";
	const tabSuffix = tab?.label ? `\u00b7${tab.label}` : "";
	const agentName = focusedAgent.display_agent ?? focusedAgent.name ?? focusedAgent.agent ?? "agent";

	let activity = activityFor(focusedAgent.agent, focusedAgent.agent_session, focusedAgent.pane_id, focusedAgent.cwd);
	if (!activity.task && !activity.now) {
		activity = { ...screenActivity(focusedAgent.pane_id), ...activity };
	}

	const rawTitle = focusedAgent.terminal_title_stripped ?? focusedAgent.label ?? "";
	const titleTopic = cleanTerminalTitle(rawTitle, wsLabel);
	const topic = activity.topic || (titleTopic && titleTopic !== wsLabel ? titleTopic : undefined);
	const fallbackHeader = `${wsLabel}${tabSuffix} \u00b7 ${agentName}`;

	return {
		paneId: focusedAgent.pane_id,
		header: topic ? `\u25b8 ${topic}` : `\u25b8 ${fallbackHeader}`,
		topic,
		task: activity.task,
		now: activity.now,
	};
}

export function buildBottomTokens(info, maxRows, width = LINE_WIDTH) {
	if (!info || (!info.task && !info.now) || maxRows < 2) return {};
	const sep = "\u2500".repeat(width);
	const top = clip(info.header, width);
	if (maxRows === 2) {
		return { b_sep: sep, b_top: top };
	}

	const tokens = {
		b_sep: sep,
		b_top: top,
	};

	const remaining = Math.min(12, maxRows - 2); // Up to 5 task lines + 7 now lines
	const hasTask = Boolean(info.task);
	const hasNow = Boolean(info.now);

	if (hasTask && hasNow) {
		const taskMax = Math.min(5, Math.max(1, Math.floor(remaining * 0.42)));
		const nowMax = Math.min(7, Math.max(1, remaining - taskMax));
		const tLines = wrapLines(`task: ${info.task}`, width, taskMax);
		const usedTask = tLines.length;
		const actualNowMax = Math.min(7, Math.max(1, remaining - usedTask));
		const nLines = wrapLines(`now: ${info.now}`, width, actualNowMax);
		tLines.forEach((line, idx) => {
			tokens[`b_t${idx + 1}`] = line;
		});
		nLines.forEach((line, idx) => {
			tokens[`b_n${idx + 1}`] = line;
		});
	} else if (hasTask) {
		const tLines = wrapLines(`task: ${info.task}`, width, Math.min(5, remaining));
		tLines.forEach((line, idx) => {
			tokens[`b_t${idx + 1}`] = line;
		});
	} else if (hasNow) {
		const nLines = wrapLines(`now: ${info.now}`, width, Math.min(7, remaining));
		nLines.forEach((line, idx) => {
			tokens[`b_n${idx + 1}`] = line;
		});
	}

	return tokens;
}

export function collect() {
	const snap = snapshot();
	if (!snap) return { ok: false, panes: [] };
	const agents = (snap.agents ?? []).filter((a) => a?.pane_id);
	if (!agents.length) return { ok: true, panes: [], anchorPaneId: undefined, focusedInfo: undefined };

	const availableRows = computeAvailableBottomRows(snap);
	const focusedInfo = resolveFocusedInfo(snap);
	const anchorPaneId = focusedInfo?.paneId;
	const bottomTokens = buildBottomTokens(focusedInfo, availableRows, LINE_WIDTH);

	const panes = agents.map((a) => {
		const isAnchor = Boolean(anchorPaneId && a.pane_id === anchorPaneId);
		return {
			paneId: a.pane_id,
			agent: a.agent,
			status: a.agent_status,
			focused: Boolean(a.focused),
			isAnchor,
			// Unfocused agents get `b_pin = "0"` so `agent.view.set` sorts them first
			// in natural workspace/tab/pane order. The focused anchor agent leaves
			// `b_pin` unset (`None` sorts after `Some("0")`), placing it at the very
			// bottom of the `agents` list with its summary block right underneath.
			tokens: isAnchor ? bottomTokens : { b_pin: "0" },
		};
	});

	return {
		ok: true,
		panes,
		anchorPaneId,
		availableRows,
		focusedInfo,
		bottomTokens,
	};
}

// ---------------------------------------------------------------- modes

function start() {
	fs.mkdirSync(STATE_DIR, { recursive: true });
	ensureSidebarConfig();
	const existing = readPid();
	if (existing && pidAlive(existing)) {
		console.log(`task-notes: already running (pid ${existing})`);
		return 0;
	}
	const out = fs.openSync(LOG_FILE, "a");
	const child = spawn(process.execPath, [new URL(import.meta.url).pathname], {
		detached: true,
		stdio: ["ignore", out, out],
		env: process.env,
	});
	child.unref();
	fs.writeFileSync(PID_FILE, `${child.pid}\n`);
	console.log(`task-notes: started (pid ${child.pid})`);
	return 0;
}

async function stop({ uninstall = false } = {}) {
	const pid = readPid();
	if (pid && pidAlive(pid)) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// Already gone.
		}
		console.log(`task-notes: stopped (pid ${pid})`);
	} else {
		console.log("task-notes: not running");
	}
	await clearAgentView();
	const snap = snapshot();
	let seq = Date.now() * 1000;
	for (const a of snap?.agents ?? []) {
		if (a?.pane_id) {
			clearMetadata(a.pane_id, ++seq, true);
			seq += 2;
		}
	}
	if (uninstall) {
		removeSidebarConfig();
		console.log("task-notes: removed sidebar layout from config.toml");
	}
	try {
		fs.rmSync(PID_FILE, { force: true });
	} catch {
		// Best effort.
	}
	return 0;
}

async function status() {
	const pid = readPid();
	const running = Boolean(pid && pidAlive(pid));
	console.log(`task-notes: ${running ? `running (pid ${pid})` : "stopped"}`);
	console.log(`plugin=${PLUGIN_ID} source=${SOURCE} interval=${INTERVAL_MS}ms width=${LINE_WIDTH} state=${STATE_DIR}`);
	const res = collect();
	if (!res.ok) {
		console.log("herdr API: unreachable");
		return 1;
	}
	const viewResp = running ? await setAgentView() : undefined;
	const viewActive = Boolean(viewResp?.result?.active);
	console.log(`anchor=${res.anchorPaneId ?? "none"} available_rows=${res.availableRows ?? 0} view_sorted=${viewActive}`);
	if (res.focusedInfo) {
		console.log(`focused=${res.focusedInfo.paneId} header="${res.focusedInfo.header}"`);
		if (res.focusedInfo.topic) console.log(`  topic: ${res.focusedInfo.topic}`);
		if (res.focusedInfo.task) console.log(`  task:  ${res.focusedInfo.task}`);
		if (res.focusedInfo.now) console.log(`  now:   ${res.focusedInfo.now}`);
	} else {
		console.log("focused=none (active tab has no agent — bottom summary hidden)");
	}
	return 0;
}

async function loop({ once = false, print = false } = {}) {
	fs.mkdirSync(STATE_DIR, { recursive: true });
	let viewSetAt = 0;
	if (!print) {
		ensureSidebarConfig();
		const r = await setAgentView();
		if (r?.result?.active) viewSetAt = Date.now();
	}
	let seq = Date.now() * 1000;
	const last = new Map();
	let failures = 0;
	let stopping = false;
	let unsubscribe = null;

	const shutdown = async () => {
		if (stopping) return;
		stopping = true;
		try {
			unsubscribe?.();
		} catch {
			// Best effort.
		}
		await clearAgentView();
		for (const paneId of last.keys()) clearMetadata(paneId, ++seq);
		try {
			fs.rmSync(PID_FILE, { force: true });
		} catch {
			// Best effort.
		}
		log("stopped");
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);

	const pass = () => {
		const res = collect();
		if (!res.ok) {
			failures += 1;
			if (failures > 30) {
				log("herdr API unreachable for 30 polls; exiting");
				shutdown();
			}
			return;
		}
		failures = 0;
		if (!print && Date.now() - viewSetAt > 30000) {
			viewSetAt = Date.now();
			setAgentView().catch(() => {});
		}
		const seen = new Set();
		for (const { paneId, isAnchor, tokens } of res.panes) {
			seen.add(paneId);
			const key = JSON.stringify(tokens);
			if (!print && last.get(paneId) === key) continue;
			if (!print) last.set(paneId, key);
			if (print) {
				if (isAnchor) {
					console.log(`anchor=${paneId} (${res.availableRows} rows available)`);
					for (const [k, v] of Object.entries(tokens)) {
						console.log(`  ${k}: ${v}`);
					}
				}
				continue;
			}
			if (Object.keys(tokens).length > 0) {
				reportMetadata(paneId, tokens, ++seq, 0);
			} else {
				clearMetadata(paneId, ++seq);
			}
		}
		if (!print) {
			for (const paneId of [...last.keys()]) {
				if (!seen.has(paneId)) {
					last.delete(paneId);
					clearMetadata(paneId, ++seq);
				}
			}
		}
	};

	if (once) {
		pass();
		return;
	}
	log(`started pid=${process.pid} interval=${INTERVAL_MS}ms width=${LINE_WIDTH}`);
	let debounceTimer = null;
	unsubscribe = subscribeEvents(() => {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			pass();
		}, 15);
	}, log);
	setInterval(pass, INTERVAL_MS);
	pass();
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const arg = process.argv[2] ?? "";
	if (arg === "--start") process.exit(start());
	else if (arg === "--stop") process.exit(await stop({ uninstall: process.argv.includes("--uninstall") }));
	else if (arg === "--uninstall") process.exit(await stop({ uninstall: true }));
	else if (arg === "--status") process.exit(await status());
	else if (arg === "--once") await loop({ once: true, print: process.argv.includes("--print") });
	else if (arg) {
		console.error(`usage: daemon.mjs [--start|--stop|--uninstall|--status|--once [--print]]`);
		process.exit(2);
	} else await loop();
}
