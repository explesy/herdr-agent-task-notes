// Per-agent transcript adapters. Each adapter reads only the tail of the
// agent's own transcript and returns { topic, task, now } — no model calls, no writes.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	basename,
	cleanProse,
	clip,
	collapse,
	commandLabel,
	firstLine,
	formatNow,
	piToolNow,
	stripNoise,
} from "./format.mjs";

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

function headJsonLines(file, maxLines = 12) {
	const fd = fs.openSync(file, "r");
	try {
		const size = Math.min(fs.fstatSync(fd).size, 16 * 1024);
		if (size <= 0) return [];
		const buf = Buffer.allocUnsafe(size);
		fs.readSync(fd, buf, 0, size, 0);
		const lines = buf
			.toString("utf8")
			.split("\n")
			.slice(0, maxLines)
			.filter((l) => l.trim());
		const out = [];
		for (const line of lines) {
			try {
				out.push(JSON.parse(line));
			} catch {
				// Ignore partial line
			}
		}
		return out;
	} finally {
		fs.closeSync(fd);
	}
}

export function piActivity(sessionPath, cwd) {
	const resolvedPath = sessionPath && fs.existsSync(sessionPath) ? sessionPath : findPiSessionByCwd(cwd);
	if (!resolvedPath || !fs.existsSync(resolvedPath)) return {};
	const head = headJsonLines(resolvedPath, 10);
	const tail = jsonLines(resolvedPath);
	const entries = [...head, ...tail];
	let topic;
	let task;
	let now;
	let model;
	let effort;
	for (let i = entries.length - 1; i >= 0 && (!topic || !task || !now || !model || !effort); i--) {
		const entry = entries[i];
		if (!topic && entry?.type === "session_info" && entry?.name) {
			topic = clip(entry.name, 70);
		}
		if (!topic && entry?.type === "custom" && entry?.customType === "recap" && entry?.data?.title) {
			topic = clip(entry.data.title, 70);
		}
		if (!model && entry?.type === "model_change" && entry?.modelId) {
			model = entry.modelId;
		}
		if (!effort && entry?.type === "thinking_level_change" && entry?.thinkingLevel) {
			effort = entry.thinkingLevel;
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
	const meta = [model, effort].filter(Boolean).join(" \u00b7 ") || undefined;
	return { topic, meta, task, now };
}

// ---------------------------------------------------------------- codex

const codexIndex = new Map(); // key -> {file, row, at}

function queryCodexThread(sessionId, cwd) {
	const cacheKey = sessionId ? `id:${sessionId}` : cwd ? `cwd:${cwd}` : undefined;
	if (!cacheKey) return undefined;
	const cached = codexIndex.get(cacheKey);
	if (cached && Date.now() - cached.at < 15_000) return cached;

	const db = path.join(os.homedir(), ".codex", "state_5.sqlite");
	if (fs.existsSync(db)) {
		try {
			const safeVal = String(sessionId || cwd).replace(/'/g, "''");
			const where = sessionId ? `id = '${safeVal}'` : `cwd = '${safeVal}'`;
			const sql = `SELECT id, rollout_path, title, name, model, reasoning_effort, git_branch, first_user_message FROM threads WHERE ${where} ORDER BY updated_at DESC LIMIT 1;`;
			const r = spawnSync("sqlite3", ["-json", db, sql], { encoding: "utf8", timeout: 1000 });
			if (r.status === 0 && r.stdout.trim()) {
				const rows = JSON.parse(r.stdout);
				if (rows[0]) {
					const entry = {
						file: rows[0].rollout_path,
						row: rows[0],
						at: Date.now(),
					};
					codexIndex.set(cacheKey, entry);
					return entry;
				}
			}
		} catch {
			// Fall back to filesystem search below.
		}
	}

	if (!sessionId) return undefined;
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
	if (!file) return undefined;
	const entry = { file, row: undefined, at: Date.now() };
	codexIndex.set(cacheKey, entry);
	return entry;
}

export function codexActivity(sessionId, cwd) {
	const found = queryCodexThread(sessionId, cwd);
	const file = found?.file;
	const row = found?.row;
	const topic = row?.name ? clip(row.name, 70) : undefined;
	const meta = [row?.model, row?.reasoning_effort].filter(Boolean).join(" \u00b7 ") || undefined;

	if (!file || !fs.existsSync(file)) {
		const fallbackTask = row?.first_user_message ? clip(stripNoise(row.first_user_message), MAX_FIELD_CHARS) : undefined;
		return { topic, meta, task: fallbackTask };
	}

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
	if (!task && row?.first_user_message) {
		task = clip(stripNoise(row.first_user_message), MAX_FIELD_CHARS);
	}
	return { topic, meta, task, now };
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

// ---------------------------------------------------------------- opencode

const opencodeSessionIndex = new Map(); // cwd -> { id, at }

function opencodeDbPath() {
	return process.env.OPENCODE_DB_PATH ?? path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
}

function sqliteJson(db, sql) {
	try {
		const r = spawnSync("sqlite3", ["-readonly", "-json", db, sql], { encoding: "utf8", timeout: 1500 });
		if (r.status !== 0 || !r.stdout.trim()) return [];
		const rows = JSON.parse(r.stdout);
		return Array.isArray(rows) ? rows : [];
	} catch {
		return [];
	}
}

const sqlLiteral = (value) => `'${String(value).replace(/'/g, "''")}'`;

let sqliteChecked;
const sqliteAvailable = () => {
	if (sqliteChecked !== undefined) return sqliteChecked;
	try {
		sqliteChecked = spawnSync("sqlite3", ["-version"], { encoding: "utf8", timeout: 1000 }).status === 0;
	} catch {
		sqliteChecked = false;
	}
	return sqliteChecked;
};

function resolveOpencodeSession(session, cwd) {
	const value = typeof session === "string" ? session : session?.value;
	if (typeof value === "string" && /^ses_[A-Za-z0-9]+$/.test(value)) return value;
	if (!cwd) return undefined;

	const cached = opencodeSessionIndex.get(cwd);
	if (cached && Date.now() - cached.at < 5_000) return cached.id;

	// Same directory can host several sessions (one per pane); the most recently
	// viewed root session is the one the pane is showing.
	const rows = sqliteJson(
		opencodeDbPath(),
		`SELECT id FROM session_v2
		 WHERE directory = ${sqlLiteral(cwd)} AND parent_id IS NULL AND time_archived IS NULL
		 ORDER BY COALESCE(time_viewed, 0) DESC, time_updated DESC LIMIT 1;`,
	);
	const id = rows[0]?.id;
	if (id) opencodeSessionIndex.set(cwd, { id, at: Date.now() });
	return id;
}

export function opencodeToolNow(name, input) {
	const a = input && typeof input === "object" ? input : {};
	const tool = String(name ?? "tool");
	const file = [a.filePath, a.path, a.file, a.filename].find((v) => typeof v === "string" && v);
	switch (tool) {
		case "bash":
		case "shell":
		case "run":
			return { verb: "run", detail: commandLabel(a.command ?? "") };
		case "read":
		case "cat":
			return { verb: "read", detail: basename(file ?? "") };
		case "edit":
		case "write":
		case "patch":
		case "multiedit":
			return { verb: "edit", detail: basename(file ?? "") };
		case "grep":
			return { verb: "grep", detail: clip(a.pattern ?? a.query ?? "", 60) };
		case "glob":
		case "find":
		case "list":
			return { verb: "find", detail: clip(a.pattern ?? a.path ?? "", 60) };
		case "webfetch":
		case "websearch":
		case "web_search":
			return { verb: "web", detail: clip(a.query ?? a.url ?? "", 60) };
		case "task":
			return { verb: "subagent", detail: clip(a.description ?? a.prompt ?? "", 60) };
		case "todowrite":
		case "todoread":
			return { verb: "todo", detail: "" };
		default:
			return {
				verb: tool,
				detail: clip(a.description ?? a.query ?? a.pattern ?? file ?? a.command ?? "", 60),
			};
	}
}

const parseOpencodeData = (raw) => {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
};

export function opencodeActivity(session, cwd) {
	const db = opencodeDbPath();
	if (!fs.existsSync(db) || !sqliteAvailable()) return {};
	const id = resolveOpencodeSession(session, cwd);
	if (!id) return {};

	const [row] = sqliteJson(db, `SELECT title, agent, model FROM session_v2 WHERE id = ${sqlLiteral(id)};`);
	if (!row) return {};

	const topic = row.title ? clip(collapse(row.title), 70) : undefined;
	const model = parseOpencodeData(row.model);
	const meta = [model?.id, model?.variant].filter(Boolean).join(" \u00b7 ") || undefined;

	const messages = sqliteJson(
		db,
		`SELECT type, data FROM session_message
		 WHERE session_id = ${sqlLiteral(id)} AND type = 'assistant'
		 ORDER BY seq DESC LIMIT 4;`,
	);
	const [lastUser] = sqliteJson(
		db,
		`SELECT data FROM session_message
		 WHERE session_id = ${sqlLiteral(id)} AND type = 'user'
		 ORDER BY seq DESC LIMIT 1;`,
	);

	let task;
	let now;
	const userData = lastUser ? parseOpencodeData(lastUser.data) : undefined;
	if (userData) {
		const cleaned = stripNoise(userData.text ?? "");
		if (cleaned) task = clip(cleaned, MAX_FIELD_CHARS);
	}

	for (const message of messages) {
		if (now) break;
		const data = parseOpencodeData(message.data);
		if (!data) continue;

		for (const part of [...(Array.isArray(data.content) ? data.content : [])].reverse()) {
			if (now) break;
			if (part?.type === "tool" && part?.state?.status === "running") {
				const { verb, detail } = opencodeToolNow(part.name, part.state.input);
				now = clip(formatNow(verb, detail), MAX_FIELD_CHARS);
			} else if (part?.type === "text" && typeof part.text === "string") {
				const text = cleanProse(part.text, MAX_FIELD_CHARS);
				if (text) now = text;
			} else if (part?.type === "reasoning" && typeof part.text === "string") {
				const text = cleanProse(part.text, 90);
				if (text) now = formatNow("thinking", text);
			}
		}
		if (!now && !data.time?.completed) now = "working\u2026";
	}

	if (!task && topic) task = topic;
	return { topic, meta, task, now };
}

// ---------------------------------------------------------------- fallback

function parseCodexScreenDetails(rawScreen) {
	if (!rawScreen.includes("Task details") && !rawScreen.includes("Last message") && !rawScreen.includes("Agent command center")) {
		return undefined;
	}
	const rightCol = [];
	let selectedRowTitle;
	for (const line of rawScreen.split("\n")) {
		const selectedMatch = line.match(/[›>]\s*[○●◆◇]\s+(.+?)\s+(?:Inactive|Ready|Working|Needs you)\b/);
		if (selectedMatch && !selectedRowTitle) {
			selectedRowTitle = selectedMatch[1].trim();
		}
		const barIdx = line.indexOf("│");
		if (barIdx >= 0) {
			rightCol.push(line.slice(barIdx + 1).trim());
		}
	}
	if (!rightCol.length) return undefined;

	let model;
	let effort;
	let lastMsgLines = [];
	let promptLines = [];
	let section = "header";
	let headerTitle;

	for (const l of rightCol) {
		if (!l || l === "Task details") continue;
		if (/^[○●]\s+(?:Inactive|Ready|Working|Needs you)$/i.test(l)) continue;
		if (l.startsWith("Model:")) {
			model = l.slice("Model:".length).trim();
			section = "meta";
			continue;
		}
		if (l.startsWith("Reasoning:")) {
			effort = l.slice("Reasoning:".length).trim();
			section = "meta";
			continue;
		}
		if (l === "Project" || l === "Branch") {
			section = "skip";
			continue;
		}
		if (l === "Last message") {
			section = "last";
			continue;
		}
		if (l === "Prompt") {
			section = "prompt";
			continue;
		}
		if (section === "header" && !headerTitle) {
			headerTitle = l;
		} else if (section === "last") {
			lastMsgLines.push(l);
		} else if (section === "prompt") {
			promptLines.push(l);
		}
	}

	const topic = headerTitle || selectedRowTitle;
	const meta = [model, effort].filter(Boolean).join(" \u00b7 ") || undefined;
	const task = promptLines.length ? cleanProse(promptLines.join(" "), MAX_FIELD_CHARS) : undefined;
	const now = lastMsgLines.length ? cleanProse(lastMsgLines.join(" "), MAX_FIELD_CHARS) : undefined;
	if (!topic && !task && !now) return undefined;
	return { topic, meta, task, now };
}

// TUI chrome that is never agent activity: hotkey hints, token/price counters,
// and the block-glyph progress bars some TUIs (OpenCode) draw around the prompt.
const TUI_FOOTER_NOISE_RE =
	/^(?:\?\s*help\b|esc\s+back\b|show\s+more\b|tab\/⇧tab\b|ctrl\+[a-z]\b)|(?:esc\s+(?:again\s+to\s+)?interrupt\b|\b\d+(?:\.\d+)?K\s*\(\d+%\)|\$\d+(?:\.\d+)?)/i;

// Drop box-drawing/blocks-only lines ("▀▀▀▀", "╹▀▀▀") so a status bar is not
// mistaken for prose when the screen fallback has to guess.
const textDensity = (line) => {
	const chars = [...line.replace(/\s+/g, "")];
	if (!chars.length) return 0;
	return chars.filter((c) => /[\p{L}\p{N}]/u.test(c)).length / chars.length;
};

export function screenActivity(paneId) {
	try {
		const r = spawnSync(HERDR, ["pane", "read", paneId, "--lines", "35"], { encoding: "utf8", timeout: 1500 });
		if (r.status !== 0 || !r.stdout) return {};
		const clean = r.stdout
			.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
			.replace(/[\u0000-\u0008\u000b-\u001f]/g, "");

		const codexDetails = parseCodexScreenDetails(clean);
		if (codexDetails) return codexDetails;

		const lines = clean
			.split("\n")
			.map((l) => l.trim())
			.filter(
				(l) =>
					l &&
					!/^[─━═│┃┏┓┗┛├┤┬┴┼╭╮╯╰\s]+$/u.test(l) &&
					!TUI_FOOTER_NOISE_RE.test(l) &&
					textDensity(l) >= 0.5,
			);
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
	if (agent === "codex") return codexActivity(value, cwd);
	if (agent === "opencode") return opencodeActivity(value, cwd);
	if ((agent === "antigravity-cli" || agent === "agy" || agent === "antigravity") && value) return agyActivity(value);
	return {};
}
