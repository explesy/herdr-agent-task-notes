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

test("cleanProse strips markdown headers, bullets, links, and compacts URLs", () => {
	const raw =
		"# Heading\n- **bold item** with `code` and [README.md](/Users/user/notes/README.md:35) plus https://example.com/docs?foo=bar\n```js\nconsole.log(1);\n```";
	const cleaned = cleanProse(raw);
	assert.equal(cleaned, "bold item with code and README.md plus example.com/docs");
});

test("cleanTerminalTitle strips spinners, leading dashes, and workspace suffixes", () => {
	assert.equal(cleanTerminalTitle("⠋ Fix click bug · acme-app", "acme-app"), "Fix click bug");
	assert.equal(cleanTerminalTitle("● Build plugin · notes"), "Build plugin");
	assert.equal(cleanTerminalTitle("π - acme-web", "acme-web"), "");
	assert.equal(cleanTerminalTitle("~/n/acme-cli", "acme-cli"), "");
});

test("buildBottomTokens returns empty object when no agent is focused", () => {
	assert.deepEqual(buildBottomTokens(undefined, 10, 29), {});
});

test("buildBottomTokens formats separator, header, meta, task, and now lines", () => {
	const tokens = buildBottomTokens(
		{
			paneId: "w3:p2",
			header: "▸ Fix click bug",
			meta: "gpt-6-luna · high",
			task: "Prevent pane switch on click",
			now: "Running tests",
		},
		10,
		29,
	);
	assert.equal(tokens.b_sep, "─".repeat(29));
	assert.equal(tokens.b_top, "▸ Fix click bug");
	assert.equal(tokens.b_meta, "gpt-6-luna · high");
	assert.ok(tokens.b_t1?.startsWith("task: "));
	assert.ok(tokens.b_n1?.startsWith("now: "));
	assert.equal(clip("short", 10), "short");
});
