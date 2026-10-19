// Self-contained management of the [ui.sidebar.agents] layout block in Herdr's
// config.toml so the plugin can install/remove its layout automatically without
// breaking GNU Stow symlinks.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { herdrBin, PLUGIN_ID } from "./herdr.mjs";

const BEGIN_MARKER = `# BEGIN plugin:${PLUGIN_ID}`;
const END_MARKER = `# END plugin:${PLUGIN_ID}`;

export const MANAGED_SIDEBAR_BLOCK = `${BEGIN_MARKER}
[ui.sidebar.agents]
rows = [
  ["state_icon", "machine", "workspace", "tab"],
  ["agent"],
  [{ token = "$b_sep", fg = "#45475a", dim = true }],
  [{ token = "$b_top", fg = "#89b4fa", bold = true }],
  [{ token = "$b_meta", fg = "#7f849c", dim = true }],
  [{ token = "$b_t1", fg = "#cdd6f4" }],
  [{ token = "$b_t2", fg = "#cdd6f4" }],
  [{ token = "$b_t3", fg = "#cdd6f4" }],
  [{ token = "$b_t4", fg = "#cdd6f4" }],
  [{ token = "$b_t5", fg = "#cdd6f4" }],
  [{ token = "$b_n1", fg = "#a6adc8", dim = true }],
  [{ token = "$b_n2", fg = "#a6adc8", dim = true }],
  [{ token = "$b_n3", fg = "#a6adc8", dim = true }],
  [{ token = "$b_n4", fg = "#a6adc8", dim = true }],
  [{ token = "$b_n5", fg = "#a6adc8", dim = true }],
  [{ token = "$b_n6", fg = "#a6adc8", dim = true }],
]
${END_MARKER}`;

export function resolveConfigPath() {
	const raw = process.env.HERDR_CONFIG_PATH ?? path.join(os.homedir(), ".config", "herdr", "config.toml");
	try {
		return fs.realpathSync(raw);
	} catch {
		return raw;
	}
}

export function reloadHerdrConfig() {
	const r = spawnSync(herdrBin(), ["server", "reload-config"], { encoding: "utf8", timeout: 5000 });
	return r.status === 0;
}

function ensureSidebarWidth(content, width = 34) {
	if (!/\[ui\]\s*\n/.test(content)) return content;
	if (/^\s*sidebar_width\s*=/m.test(content)) {
		return content
			.replace(/^\s*sidebar_width\s*=\s*\d+/m, `sidebar_width = ${width}`)
			.replace(/^\s*sidebar_max_width\s*=\s*\d+/m, `sidebar_max_width = ${Math.max(36, width)}`);
	}
	return content.replace(/\[ui\]\s*\n/, `[ui]\nsidebar_width = ${width}\nsidebar_max_width = ${Math.max(36, width)}\n`);
}

function stripExistingAgentSidebarBlock(content) {
	// 1. Strip any previous plugin:*.agent-task-notes managed block if present.
	const managedRe = /\n?# BEGIN plugin:[^\n]*agent-task-notes[\s\S]*?# END plugin:[^\n]*agent-task-notes\n?/g;
	let out = content.replace(managedRe, "\n");

	// 2. Strip any standalone [ui.sidebar.agents] section (including preceding comment lines)
	// up to the next [section] header or EOF.
	const standaloneRe = /\n?(?:#[^\n]*\n)*\[ui\.sidebar\.agents\]\s*\n[\s\S]*?(?=\n\[|$)/g;
	out = out.replace(standaloneRe, "\n");
	return out.replace(/\n{3,}/g, "\n\n").trimEnd();
}

export function ensureSidebarConfig() {
	const file = resolveConfigPath();
	if (!fs.existsSync(file)) return false;
	const current = fs.readFileSync(file, "utf8");
	const withWidth = ensureSidebarWidth(current, 34);
	if (withWidth === current && current.includes(MANAGED_SIDEBAR_BLOCK)) return false;

	const stripped = stripExistingAgentSidebarBlock(withWidth);
	const keysIdx = stripped.search(/\n\[keys\]/);
	let next;
	if (keysIdx >= 0) {
		next = `${stripped.slice(0, keysIdx).trimEnd()}\n\n${MANAGED_SIDEBAR_BLOCK}\n\n${stripped.slice(keysIdx + 1)}\n`;
	} else {
		next = `${stripped}\n\n${MANAGED_SIDEBAR_BLOCK}\n`;
	}
	fs.writeFileSync(file, next, "utf8");
	reloadHerdrConfig();
	return true;
}

export function removeSidebarConfig() {
	const file = resolveConfigPath();
	if (!fs.existsSync(file)) return false;
	const current = fs.readFileSync(file, "utf8");
	const next = `${stripExistingAgentSidebarBlock(current)}\n`;
	if (next === current) return false;
	fs.writeFileSync(file, next, "utf8");
	reloadHerdrConfig();
	return true;
}
