import assert from "node:assert/strict";
import test from "node:test";
import { activityFor, opencodeToolNow } from "../lib/adapters.mjs";

test("opencodeToolNow maps shell, edit, and grep tool calls to short verbs", () => {
	assert.deepEqual(opencodeToolNow("shell", { command: "cd /tmp && pnpm test" }), {
		verb: "run",
		detail: "pnpm test",
	});
	assert.deepEqual(opencodeToolNow("edit", { filePath: "/Users/user/app/main.ts" }), {
		verb: "edit",
		detail: "main.ts",
	});
	assert.deepEqual(opencodeToolNow("grep", { pattern: "TODO" }), { verb: "grep", detail: "TODO" });
});

test("activityFor degrades to {} for opencode when the database is unavailable", () => {
	const previous = process.env.OPENCODE_DB_PATH;
	process.env.OPENCODE_DB_PATH = "/nonexistent/opencode.db";
	try {
		assert.deepEqual(activityFor("opencode", undefined, "w1:p1", "/tmp"), {});
	} finally {
		if (previous === undefined) delete process.env.OPENCODE_DB_PATH;
		else process.env.OPENCODE_DB_PATH = previous;
	}
});
