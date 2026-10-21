# herdr-agent-task-notes

A [Herdr](https://herdr.dev) plugin that adds a live **task & activity summary** below the `agents` list in the sidebar for the active agent tab.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-5FA04E?logo=node.js&logoColor=white)

```text
╭─ agents ────────────────────╮
│ ◦ acme-app · 2              │
│   pi                        │
│ ● acme-web · 3              │
│   pi                        │
│ ◦ acme-api · 2              │
│   pi                        │
│ ─────────────────────────── │
│ ▸ acme-web·3 · pi           │
│ deepseek-v4.1-flash · low   │
│ task: add retry handling to │
│ the sync job                │
│ now: Running tests: pnpm    │
│ test                        │
╰─────────────────────────────╯
```

## Features

- **Compact, stable agent list** — every agent stays a clean 2-line entry (`state_icon workspace · tab` + `agent`) in its natural order. Focus changes never reorder the list.
- **Session-aware details** — shows the session topic, model and reasoning effort, the latest user request (`task:`), and the current agent activity or last message (`now:`).
- **Readable by design** — long URLs and Markdown links are compacted, lines are wrapped to the sidebar width, and noisy terminal chrome is filtered out.
- **Instant focus response** — refreshes on `workspace.focused`, `tab.focused`, and `pane.focused` events over Herdr's Unix socket, with background transcript polling as a fallback.
- **Hidden when not relevant** — the summary disappears when the focused tab has no agent.
- **No npm dependencies** — pure Node.js ES modules. The system `sqlite3` CLI is used when available.
- **Safe configuration management** — adds and removes only its own managed block in Herdr's `config.toml`, so GNU Stow and hand-written settings keep working.

## Supported agents

| Agent | Source inspected |
| :--- | :--- |
| **`pi`** | `~/.config/pi/sessions/**/*.jsonl` (matched by `agent_session` or workspace `cwd`) |
| **`codex`** | `~/.codex/state_5.sqlite` + `~/.codex/sessions/**/*.jsonl` + Codex Agent Command Center screen parser |
| **`opencode`** | `~/.local/share/opencode/opencode.db` (`session_v2` + `session_message`; matched by `agent_session` or workspace `cwd`) |
| **`agy`** (Antigravity) | `~/.gemini/antigravity-cli` / `~/.gemini/antigravity` (`annotations/*.pbtxt` + `brain/<id>/.system_generated/logs/transcript.jsonl`) |
| **Fallback** | Live terminal screen scrape via `herdr pane read` (TUI status bars and hotkey footers are filtered out) |

## Requirements

- [Herdr](https://herdr.dev) `>= 0.9.0`
- Node.js `>= 20`
- `sqlite3` CLI (recommended; needed for Codex and OpenCode session discovery)
- macOS or Linux

## Installation

### From GitHub

```sh
herdr plugin install explesy/herdr-agent-task-notes
```

### From a local checkout

```sh
git clone https://github.com/explesy/herdr-agent-task-notes.git ~/notes/herdr-agent-task-notes
herdr plugin link ~/notes/herdr-agent-task-notes
node ~/notes/herdr-agent-task-notes/bin/daemon.mjs --start
```

Once the plugin is installed or linked, Herdr runs its `[[startup]]` hook (`node bin/daemon.mjs --start`) when the server starts.

## Usage

All actions are available from the Herdr command palette:

| Action | What it does |
| :--- | :--- |
| **Task notes: start** | Starts the background daemon and ensures the sidebar layout in `config.toml` |
| **Task notes: status** | Prints daemon state and the extracted `task` / `now` for the focused pane |
| **Task notes: refresh now** | Runs a single pass and prints the generated sidebar tokens |
| **Task notes: stop and clear** | Stops the daemon and clears the reported sidebar tokens |
| **Task notes: stop and remove sidebar layout** | Also removes the managed block from `config.toml` |

The same operations are available directly from the CLI:

```sh
node bin/daemon.mjs --start      # start the daemon, update config.toml
node bin/daemon.mjs --status     # daemon status + current task/now
node bin/daemon.mjs --once --print
node bin/daemon.mjs --stop       # stop and clear tokens
node bin/daemon.mjs --uninstall  # stop, clear tokens, remove config block
```

## Configuration

Environment variables are optional:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `TASK_NOTES_INTERVAL_MS` | `1500` | Transcript polling interval in milliseconds |
| `TASK_NOTES_WIDTH` | `21` | Wrap width in characters for summary lines. The plugin configures `sidebar_width = 34` in `config.toml`. |
| `HERDR_CONFIG_PATH` | `~/.config/herdr/config.toml` | Path to Herdr's configuration file |
| `HERDR_SOCKET_PATH` | `~/.config/herdr/herdr.sock` | Path to Herdr's Unix domain socket |
| `HERDR_BIN_PATH` | `herdr` | Path to the Herdr executable |
| `HERDR_PLUGIN_STATE_DIR` | `~/.local/state/herdr-task-notes` | Directory for the daemon PID file and log |
| `OPENCODE_DB_PATH` | `~/.local/share/opencode/opencode.db` | Path to OpenCode's state database (read-only) |

The daemon writes its PID and log to `HERDR_PLUGIN_STATE_DIR`. The sidebar layout is kept inside a managed block:

```toml
# BEGIN plugin:explesy.agent-task-notes
# ...
# END plugin:explesy.agent-task-notes
```

## How it works

The plugin starts a small detached Node.js daemon. On each pass it reads the focused agent's session state, extracts the topic, model, latest user request, and current activity, then reports them as Herdr pane metadata tokens (`b_sep`, `b_top`, `b_meta`, `b_t1`, `b_n1`, and so on). The configured sidebar layout renders those tokens below the agent list. Values are cleared when the daemon stops or the agent disappears.

### Privacy

The plugin reads local agent session files and databases **read-only** and talks only to the local Herdr Unix socket. It has no telemetry and makes no network requests.

## Troubleshooting

- **Nothing appears in the sidebar** — run `node bin/daemon.mjs --status`. It reports whether the daemon is running, whether Herdr's API is reachable, and what was extracted for the focused pane.
- **Summary is stale** — lower `TASK_NOTES_INTERVAL_MS` or check the log in `HERDR_PLUGIN_STATE_DIR`.
- **Codex/OpenCode details are missing** — make sure the `sqlite3` CLI is installed and on `PATH`.
- **Sidebar layout looks wrong** — run `node bin/daemon.mjs --uninstall` and then `--start` to recreate the managed block.

## Development

```sh
npm test
node bin/daemon.mjs --once --print
node bin/label.mjs pi /path/to/session.jsonl   # inspect a single agent session
```

The source is plain ES modules: adapters in `lib/adapters.mjs`, text formatting in `lib/format.mjs`, Herdr integration in `lib/herdr.mjs`, and daemon/CLI entry points in `bin/`.

## Contributing

Issues and pull requests are welcome. Please run `npm test` before opening a PR.

## License

[MIT](./LICENSE)
