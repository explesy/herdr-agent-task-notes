// Per-agent transcript adapters. Each adapter reads only the tail of the
// agent's own transcript and returns { topic, task, now } — no model calls, no writes.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { basename, cleanProse, clip, commandLabel, firstLine, formatNow, piToolNow, stripNoise } from "./format.mjs";

const HERDR = process.env.HERDR_BIN_PATH ?? "herdr";
const TAIL_BYTES = 768 * 1024;
const MAX_FIELD_CHARS = 260;

export function readLines(file, maxBytes = TAIL_BYTES) {
	const fd = fs.openSync(file, "r");
	try {
		const size = fs.fstatSync(fd).size;
		const start = Math.max(0, size - maxBytes);
		const buf = Buffer.allocUnsafe(size - start);
		fs.readSync(fd, buf, 0, buf.length, start);
		let text = buf.toString("utf8");
		if (start > 0) {
			const nl = text.indexOf("\n");
			text = nl >= 0 ? text.slice(nl + 1) : "";
		}
		return text.split("\n").filter((l) => l.trim());
	} finally {
		fs.closeSync(fd);
	}
}

function jsonLines(file, maxBytes) {
	const out = [];
	for (const line of readLines(file, maxBytes)) {
		try {
			out.push(JSON.parse(line));
		} catch {
			// A partially written last line is normal while an agent is streaming.
		}
	}
	return out;
}

function textOf(content) {
	if (!Array.isArray(content)) return "";
	return content
		.map((c) => (c && typeof c === "object" ? (c.text ?? c.thinking ?? "") : ""))
		.filter(Boolean)
		.join(" ");
}

// ---------------------------------------------------------------- pi

function findPiSessionByCwd(cwd) {
	if (!cwd) return undefined;
	const slug = `--${String(cwd).replace(/^[/\\]+/, "").replace(/[/\\:]+/g, "-")}--`;
	const dir = path.join(os.homedir(), ".config", "pi", "sessions", slug);
	try {
		const files = fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => path.join(dir, f));
		files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
		return files[0];
	} catch {
		return undefined;
	}
}

export function piActivity(sessionPath, cwd) {
	const resolvedPath = sessionPath && fs.existsSync(sessionPath) ? sessionPath : findPiSessionByCwd(cwd);
	if (!resolvedPath || !fs.existsSync(resolvedPath)) return {};
	const entries = jsonLines(resolvedPath);
	let topic;
	let task;
	let now;
	for (let i = entries.length - 1; i >= 0 && (!topic || !task || !now); i--) {
		const entry = entries[i];
		if (!topic && entry?.type === "session_info" && entry?.name) {
			topic = clip(entry.name, 70);
		}
		const m = entry?.message;
		if (!m) continue;
		if (!task && m.role === "user") {
			const cleaned = stripNoise(textOf(m.content));
			if (cleaned) task = clip(cleaned, MAX_FIELD_CHARS);
		}
		if (!now && m.role === "assistant") {
			const calls = (m.content ?? []).filter((c) => c?.type === "toolCall");
			if (calls.length) {
				const call = calls[calls.length - 1];
				const { verb, detail } = piToolNow(call.name, call.arguments ?? {});
				now = clip(formatNow(verb, detail), MAX_FIELD_CHARS);
			} else {
				const rawText = (m.content ?? [])
					.filter((c) => c?.type === "text")
					.map((c) => c?.text ?? "")
					.filter(Boolean)
					.join("\n");
				const prose = cleanProse(rawText, MAX_FIELD_CHARS);
				if (prose) {
					now = prose;
				} else {
					const thinking = (m.content ?? [])
						.filter((c) => c?.type === "thinking")
						.map((c) => c?.thinking ?? "")
						.filter(Boolean)
						.join(" ");
					if (thinking) now = formatNow("thinking", cleanProse(thinking, 90));
				}
			}
		}
	}
	return { topic, task, now };
}

// ---------------------------------------------------------------- codex

const codexIndex = new Map(); // sessionId -> {file, at}

function findCodexRollout(sessionId) {
	if (!sessionId) return undefined;
	const cached = codexIndex.get(sessionId);
	if (cached && Date.now() - cached.at < 60_000 && fs.existsSync(cached.file)) return cached.file;
	const root = path.join(os.homedir(), ".codex", "sessions");
	const hits = [];
	const walk = (dir) => {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.endsWith(".jsonl") && e.name.includes(sessionId)) hits.push(p);
		}
	};
	walk(root);
	hits.sort((a, b) => {
		try {
			return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
		} catch {
			return 0;
		}
	});
	const file = hits[0];
	if (file) codexIndex.set(sessionId, { file, at: Date.now() });
	return file;
}

export function codexActivity(sessionId) {
	const file = findCodexRollout(sessionId);
	if (!file) return {};
	const items = jsonLines(file);
	let task;
	let now;
	for (let i = items.length - 1; i >= 0 && (!task || !now); i--) {
		const d = items[i];
		const p = d?.payload ?? {};
		if (d?.type === "event_msg" && p.type === "item_completed") {
			const it = p.item ?? {};
			if (!task && it.type === "UserMessage") {
				const cleaned = stripNoise(textOf(it.content));
				if (cleaned) task = clip(cleaned, MAX_FIELD_CHARS);
			}
			if (!now) {
				if (it.type === "CommandExecution") now = formatNow("run", commandLabel(it.command, 90));
				else if (it.type === "FileChange") {
					const files = Object.keys(it.changes ?? {});
					if (files.length) now = formatNow("edit", files.map(basename).slice(0, 3).join(", "));
				} else if (it.type === "AgentMessage") {
					const text = cleanProse(textOf(it.content), MAX_FIELD_CHARS);
					if (text) now = text;
				} else if (it.type === "Reasoning") now = "thinking\u2026";
			}
		} else if (!now && d?.type === "response_item") {
			if (p.type === "custom_tool_call") {
				now = formatNow("run", commandLabel(String(p.input ?? "").split("\n")[0], 90));
			} else if (p.type === "function_call") {
				now = formatNow(String(p.name ?? "tool").toLowerCase(), clip(String(p.arguments ?? ""), 80));
			} else if (p.type === "message" && p.role === "assistant") {
				const text = cleanProse(textOf((p.content ?? []).filter((c) => c?.type === "output_text")), MAX_FIELD_CHARS);
				if (text) now = text;
			}
		}
	}
	return { task, now };
}

// ---------------------------------------------------------------- agy (Antigravity CLI / IDE)

function resolveAgyPaths(conversationId) {
	const roots = [
		path.join(os.homedir(), ".gemini", "antigravity-cli"),
		path.join(os.homedir(), ".gemini", "antigravity"),
	];
	for (const base of roots) {
		const transcript = path.join(base, "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
		const annotation = path.join(base, "annotations", `${conversationId}.pbtxt`);
		if (fs.existsSync(transcript) || fs.existsSync(annotation)) {
			return { transcript, annotation };
		}
	}
	const fallback = roots[0];
	return {
		transcript: path.join(fallback, "brain", conversationId, ".system_generated", "logs", "transcript.jsonl"),
		annotation: path.join(fallback, "annotations", `${conversationId}.pbtxt`),
	};
}

export function agyActivity(conversationId) {
	if (!conversationId) return {};
	const { transcript, annotation } = resolveAgyPaths(conversationId);
	let topic;
	try {
		const pbtxt = fs.readFileSync(annotation, "utf8");
		const m = pbtxt.match(/title\s*:\s*"((?:[^"\\]|\\.)*)"/);
		if (m) topic = clip(m[1].replace(/\\"/g, '"'), 70);
	} catch {
		// No annotation yet: the conversation has no title.
	}
	if (!fs.existsSync(transcript)) return { topic, task: topic };
	const steps = jsonLines(transcript);
	let task;
	let now;
	for (let i = steps.length - 1; i >= 0 && (!task || !now); i--) {
		const s = steps[i];
		const isUser = s?.source === "USER" || s?.source === "USER_EXPLICIT" || s?.type === "USER_INPUT";
		if (!task && isUser && s?.content) {
			const cleaned = stripNoise(s.content);
			if (cleaned) task = clip(cleaned, MAX_FIELD_CHARS);
		}
		if (!now && !isUser) {
			const calls = s?.tool_calls;
			if (Array.isArray(calls) && calls.length) {
				const call = calls[calls.length - 1];
				const args = call.arguments ?? call.args ?? {};
				const detail =
					args.toolAction ??
					args.toolSummary ??
					args.CommandLine ??
					args.query ??
					args.TargetFile ??
					args.AbsolutePath ??
					args.path ??
					args.command ??
					"";
				const name = String(call.name ?? "tool").replace(/^default_api:/, "");
				now = clip(formatNow(name, String(detail).replace(/^"|"$/g, "")), MAX_FIELD_CHARS);
			} else if (s?.content && s?.type === "PLANNER_RESPONSE") {
				const text = cleanProse(String(s.content).replace(/^\s*(?:Created|Completed) At:.*$/gm, ""), MAX_FIELD_CHARS);
				if (text) now = text;
			}
		}
	}
	if (!task && topic) task = topic;
	return { topic, task, now };
}

// ---------------------------------------------------------------- fallback

export function screenActivity(paneId) {
	try {
		const r = spawnSync(HERDR, ["pane", "read", paneId, "--lines", "30"], { encoding: "utf8", timeout: 1500 });
		if (r.status !== 0 || !r.stdout) return {};
		const clean = r.stdout
			.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
			.replace(/[\u0000-\u0008\u000b-\u001f]/g, "");
		const lines = clean
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l && !/^[─━═│┃┏┓┗┛├┤┬┴┼╭╮╯╰\s]+$/u.test(l));
		if (!lines.length) return {};
		const tail = lines.slice(-2).join(" \u00b7 ");
		return { now: firstLine(tail, MAX_FIELD_CHARS) };
	} catch {
		return {};
	}
}

export function activityFor(agent, session, paneId, cwd) {
	const value = session?.value;
	if (agent === "pi") return piActivity(value, cwd);
	if (agent === "codex" && value) return codexActivity(value);
	if ((agent === "antigravity-cli" || agent === "agy" || agent === "antigravity") && value) return agyActivity(value);
	return {};
}
