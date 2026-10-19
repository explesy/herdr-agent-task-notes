#!/usr/bin/env node
// One-shot label extraction, for testing adapters without Herdr:
//   node bin/label.mjs pi /path/to/session.jsonl
//   node bin/label.mjs codex <session-id>
//   node bin/label.mjs agy <conversation-id>

import { agyActivity, codexActivity, piActivity } from "../lib/adapters.mjs";

const [agent, value] = process.argv.slice(2);
if (!agent || !value) {
	console.error("usage: label.mjs <pi|codex|agy> <session-path-or-id>");
	process.exit(2);
}

let out;
if (agent === "pi") out = piActivity(value);
else if (agent === "codex") out = codexActivity(value);
else if (agent === "agy" || agent === "antigravity-cli") out = agyActivity(value);
else {
	console.error(`unknown agent: ${agent}`);
	process.exit(2);
}

const summary = [out.task, out.now].filter(Boolean).join(" \u00b7 ");
console.log(JSON.stringify({ ...out, summary: summary.slice(0, 80) }, null, 2));
