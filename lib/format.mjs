// Pure text helpers: cleaning, clipping, word-wrapping, and tool-name -> short verb mapping.

export function collapse(text) {
	return String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

function compactUrlsAndLinks(text) {
	let t = String(text ?? "");
	// Convert markdown links `[label](url)` -> `label`
	t = t.replace(/\[([^\]]+)\]\((?:https?:\/\/|file:\/\/|\/)[^)]+\)/g, "$1");
	// Shorten bare URLs `https://domain.tld/foo/bar/baz` -> `domain.tld/foo`
	t = t.replace(/https?:\/\/([^\s/]+)(\/[^\s/?#)]*)?(?:[^\s)]*)/gi, (_, host, p = "") => {
		const cleanHost = host.replace(/^www\./i, "");
		const firstSeg = p.split("/").filter(Boolean)[0];
		return firstSeg ? `${cleanHost}/${firstSeg}` : cleanHost;
	});
	return t;
}

export function stripNoise(text) {
	let t = String(text ?? "");
	t = t.replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/gi, " ");
	t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, " ");
	t = t.replace(/<user_instructions>[\s\S]*?<\/user_instructions>/gi, " ");
	t = t.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, " ");
	t = t.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, " ");
	t = t.replace(/<\/?USER_REQUEST>/gi, " ");
	t = t.replace(/^#\s*AGENTS\.md instructions for .*$/gim, " ");
	t = t.replace(/##\s*Memory[\s\S]*$/i, " ");
	t = t.replace(/```[\s\S]*?```/g, " ");
	t = compactUrlsAndLinks(t);
	t = t.replace(/`+/g, "");
	t = t.replace(/^\s{0,3}[#>*\-]+\s*/gm, " ");
	return collapse(t);
}

export function cleanProse(text, max = 220) {
	let t = String(text ?? "");
	t = t.replace(/```[\s\S]*?```/g, " ");
	// Drop standalone markdown headings so we capture the actual content sentence.
	t = t.replace(/^\s*#{1,6}\s+[^\n]+$/gm, " ");
	t = compactUrlsAndLinks(t);
	t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
	t = t.replace(/`+/g, "");
	t = t.replace(/^\s{0,3}[>*\-]+\s*/gm, " ");
	return clip(collapse(t), max);
}

export function cleanTerminalTitle(title, workspaceLabel = "") {
	let t = collapse(title);
	t = t.replace(/^[π●○◆◇⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*/u, "");
	t = t.replace(/^[-–—·:\s]+/u, "");
	if (workspaceLabel) {
		const suffix = ` \u00b7 ${workspaceLabel}`;
		if (t.endsWith(suffix)) t = t.slice(0, -suffix.length).trim();
	}
	t = t.replace(/\s*\u00b7\s*[^·]+$/u, "").trim();
	t = t.replace(/^[-–—·:\s]+/u, "").trim();
	if (!t || t.startsWith("~/") || t.startsWith("/")) return "";
	if (workspaceLabel && t.toLowerCase() === workspaceLabel.toLowerCase()) return "";
	return t;
}

function chars(str) {
	return Array.from(String(str ?? ""));
}

export function clip(text, max = 64) {
	const c = chars(collapse(text));
	if (c.length <= max) return c.join("");
	return `${c.slice(0, Math.max(0, max - 1)).join("").trimEnd()}\u2026`;
}

export function wrapLines(text, width = 22, maxLines = 3) {
	const cleaned = collapse(text);
	if (!cleaned || maxLines <= 0 || width <= 1) return [];
	const words = cleaned.split(" ").filter(Boolean);
	const rawLines = [];
	let current = "";

	const pushChunkedWord = (word) => {
		const wChars = chars(word);
		let idx = 0;
		while (idx < wChars.length) {
			const chunk = wChars.slice(idx, idx + width).join("");
			idx += width;
			if (idx < wChars.length) rawLines.push(chunk);
			else current = chunk;
		}
	};

	for (const word of words) {
		const wLen = chars(word).length;
		if (!current) {
			if (wLen <= width) current = word;
			else pushChunkedWord(word);
			continue;
		}
		const candidate = `${current} ${word}`;
		if (chars(candidate).length <= width) {
			current = candidate;
		} else {
			rawLines.push(current);
			current = "";
			if (wLen <= width) current = word;
			else pushChunkedWord(word);
		}
	}
	if (current) rawLines.push(current);

	if (rawLines.length <= maxLines) return rawLines;
	const clipped = rawLines.slice(0, maxLines);
	const lastChars = chars(clipped[maxLines - 1]);
	if (lastChars.length >= width) {
		clipped[maxLines - 1] = `${lastChars.slice(0, width - 1).join("").trimEnd()}\u2026`;
	} else {
		clipped[maxLines - 1] = `${clipped[maxLines - 1].replace(/[.,;:!?-]+$/u, "").trimEnd()}\u2026`;
	}
	return clipped;
}

export function basename(p) {
	const s = String(p ?? "");
	const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
	return i >= 0 ? s.slice(i + 1) : s;
}

export function firstLine(text, max = 64) {
	const line = String(text ?? "")
		.split("\n")
		.map((l) => l.trim())
		.find(Boolean);
	return clip(line ?? "", max);
}

export function commandLabel(cmd, max = 90) {
	let c = collapse(Array.isArray(cmd) ? cmd.join(" ") : cmd);
	c = c.replace(/^\/bin\/(?:zsh|bash|sh)\s+-l?c\s+/, "");
	c = c.replace(/^['"]|['"]$/g, "");
	c = c.replace(/^(?:cd\s+\S+\s*&&\s*)+/, "");
	return clip(c, max);
}

export function formatNow(verb, detail) {
	const d = collapse(detail);
	return d ? `${verb}: ${d}` : String(verb);
}

export function piToolNow(name, args = {}) {
	const a = args && typeof args === "object" ? args : {};
	switch (name) {
		case "bash":
		case "shell":
		case "run":
			return { verb: "run", detail: commandLabel(a.command ?? a.cmd ?? a.script ?? "") };
		case "read":
		case "cat":
			return { verb: "read", detail: basename(a.path ?? a.file ?? a.file_path ?? "") };
		case "edit":
		case "write":
		case "patch":
		case "apply_patch":
			return { verb: "edit", detail: basename(a.path ?? a.file ?? a.file_path ?? "") };
		case "grep":
			return { verb: "grep", detail: clip(a.pattern ?? a.query ?? "", 60) };
		case "find":
		case "glob":
		case "ls":
			return { verb: "find", detail: clip(a.pattern ?? a.path ?? "", 60) };
		case "codemode":
			return { verb: "codemode", detail: clip(String(a.script ?? a.code ?? "").split("\n")[0], 60) };
		case "subagent":
			return { verb: "subagent", detail: clip(a.agent ?? a.task ?? "", 60) };
		case "tool_search":
			return { verb: "search tools", detail: clip(a.query ?? "", 60) };
		case "web_search":
		case "web_read":
		case "web_fetch":
			return { verb: "web", detail: clip(a.query ?? a.url ?? "", 60) };
		default:
			return {
				verb: String(name ?? "tool"),
				detail: clip(a.query ?? a.pattern ?? a.path ?? a.url ?? a.description ?? "", 60),
			};
	}
}
