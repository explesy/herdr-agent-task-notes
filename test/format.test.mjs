import assert from "node:assert/strict";
import test from "node:test";
import { buildBottomTokens } from "../bin/daemon.mjs";
import { cleanProse, cleanTerminalTitle, clip, wrapLines } from "../lib/format.mjs";

test("wrapLines wraps text across multiple lines and ellipsizes overflow", () => {
	const lines = wrapLines("task: Fix sidebar click bug and prepare GitHub repo", 20, 3);
	assert.ok(lines.length >= 2 && lines.length <= 3);
	for (const line of lines) {
		assert.ok([...line].length <= 20, `line too long: "${line}"`);
	}
});

test("cleanProse strips markdown headers, bullets, and code fences", () => {
	const raw = "# Heading\n- **bold item** with `code`\n```js\nconsole.log(1);\n```";
	const cleaned = cleanProse(raw);
	assert.equal(cleaned, "bold item with code");
});

test("cleanTerminalTitle strips spinners and workspace suffixes", () => {
	assert.equal(cleanTerminalTitle("⠋ Fix click bug · acme-app", "acme-app"), "Fix click bug");
	assert.equal(cleanTerminalTitle("● Build plugin · notes"), "Build plugin");
});

test("buildBottomTokens returns empty object when no agent is focused", () => {
	assert.deepEqual(buildBottomTokens(undefined, 10, 22), {});
});

test("buildBottomTokens formats separator, header, task, and now lines", () => {
	const tokens = buildBottomTokens(
		{
			paneId: "w3:p2",
			header: "▸ Fix click bug",
			task: "Prevent pane switch on click",
			now: "Running tests",
		},
		10,
		22,
	);
	assert.equal(tokens.b_sep, "─".repeat(22));
	assert.equal(tokens.b_top, "▸ Fix click bug");
	assert.ok(tokens.b_t1?.startsWith("task: "));
	assert.ok(tokens.b_n1?.startsWith("now: "));
	assert.equal(clip("short", 10), "short");
});
