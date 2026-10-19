# herdr-agent-task-notes

A [Herdr](https://herdr.dev) plugin that renders a live multi-line **task & activity summary** below the `agents` list in the left sidebar for the currently active agent tab (`pi`, `codex`, `agy`).

```text
╭─ agents ─────────────╮
│ ◦ acme-app · 2       │
│   pi                 │
│ ● acme-web · 3       │
│   pi                 │
│ ◦ acme-api · 2       │
│   pi                 │
│ ──────────────────── │
│ ▸ acme-web·3 · pi    │
│ task: add retry      │
│ handling to the sync │
│ job                  │
│ now: Running tests:  │
│ pnpm test            │
╰──────────────────────╯
```

## Features

- **Compact agent list** — Every agent in the sidebar stays a clean 2-line entry (`state_icon workspace · tab` + `agent`).
- **Live multi-line summary below the list** — Displays the current session topic (`▸ …`), initial/latest user request (`task: …`, up to 5 wrapped lines), and real-time agent status or tool action (`now: …`, up to 7 dimmed wrapped lines).
- **Hidden on non-agent tabs** — Switching to a regular shell/editor tab automatically hides the summary block so the sidebar stays clean.
- **Click-safe summary area** — Uses Herdr's `agent.view.set` API to pin the active agent to the bottom of the list while attaching the summary rows directly to the focused agent's `pane_id`. Clicking anywhere on the summary text targets the already-focused pane and **never switches tabs or panes**.
- **Instant focus response (<30 ms)** — Subscribes to `workspace.focused`, `tab.focused`, and `pane.focused` events over Herdr's Unix socket (`events.subscribe`) in addition to background transcript polling.
- **Zero external dependencies** — Pure Node.js ES modules (`node >= 20`), GNU Stow symlink-safe `config.toml` management.

## Supported Agents

| Agent | Source inspected |
| :--- | :--- |
| **`pi`** | `~/.pi/agent/sessions/**/*.jsonl` (matched by `agent_session` or workspace `cwd`) |
| **`codex`** | `~/.codex/sessions/**/*.jsonl` (matched by `agent_session` UUID or workspace `cwd`) |
| **`agy`** (Antigravity) | `~/.gemini/antigravity-cli/state/sessions/*.json` + `~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl` |
| **Fallback** | Live terminal screen scrape via `herdr pane get-screen` |

## Requirements

- [Herdr](https://herdr.dev) `>= 0.9.0`
- Node.js `>= 20`

## Installation

### From GitHub (via Herdr CLI)

```sh
herdr plugin install explesy/herdr-agent-task-notes
```

### Local checkout / development

```sh
git clone https://github.com/explesy/herdr-agent-task-notes.git ~/notes/herdr-agent-task-notes
herdr plugin link ~/notes/herdr-agent-task-notes
node ~/notes/herdr-agent-task-notes/bin/daemon.mjs --start
```

Once linked or installed, Herdr automatically runs `[[startup]]` (`node bin/daemon.mjs --start`) when the server starts.

## Plugin Actions & CLI

You can control the plugin from the Herdr command palette or directly via CLI:

```sh
# Start the background daemon and ensure [ui.sidebar.agents] layout in config.toml
node bin/daemon.mjs --start

# Check daemon status and inspect extracted task/now for the focused pane
node bin/daemon.mjs --status

# Run a single pass and print the generated sidebar tokens
node bin/daemon.mjs --once --print

# Stop the daemon and clear sidebar tokens
node bin/daemon.mjs --stop

# Stop the daemon, clear tokens, and remove the managed block from config.toml
node bin/daemon.mjs --uninstall
```

## Configuration

Environment variables (optional):

| Variable | Default | Description |
| :--- | :--- | :--- |
| `TASK_NOTES_INTERVAL_MS` | `1500` | Transcript polling interval in milliseconds |
| `TASK_NOTES_WIDTH` | `22` | Character wrap width for summary lines |
| `HERDR_CONFIG_PATH` | `~/.config/herdr/config.toml` | Path to Herdr's configuration file |
| `HERDR_SOCKET_PATH` | `~/.config/herdr/herdr.sock` | Path to Herdr's Unix domain socket |

## Publishing to the Herdr Plugin Directory

To list this repository on [herdr.dev/plugins](https://herdr.dev/plugins), add the **`herdr-plugin`** topic to the GitHub repository:

```sh
gh repo edit explesy/herdr-agent-task-notes --add-topic herdr-plugin
```

## License

[MIT](./LICENSE)
