# NoSleep

**A self-hosted control plane for Claude Code.** NoSleep keeps your coding
agents working on the right thing across days, projects and context
compactions — with durable strategy trees, a cross-session memory ("the
Brain"), budget pacing, and a dashboard + phone app to watch and steer it all.

> Status: personal project, open-sourced as-is. It runs 24/7 on the author's
> Mac. Linux works for the server + dashboard; Windows and Android are beta.
> See [Platform support](#platform-support).

## Why

Claude Code is great inside one session. What it doesn't give you:

- **Persistence across sessions** — the plan, the decisions, and what was
  learned survive `/clear`, compaction and restarts.
- **Cadence** — loops, schedules and wake-ups across many projects, with a
  no-progress guard so loops don't burn tokens spinning.
- **Focus** — goal re-injection after compaction, drift detection, and a
  completeness check that rejects stubs before a task is marked done.
- **Budget awareness** — token usage per account/project, with pacing modes
  that make sessions leaner as you approach your limit.
- **Remote control** — see every session from the web dashboard, the macOS
  menu bar, or your phone; answer escalations and inject messages.

Inside a session, parallelism belongs to Claude Code's own subagents/teams.
NoSleep is the layer *around* sessions: memory, scheduling, and oversight.

## Features

| | |
|---|---|
| **Strategy trees** | Unlimited-depth strategy → goal → task → subtask trees with FS/SS/FF/SF dependencies, priority, acceptance criteria, progress roll-up, and `strategy_next` to pick the next unblocked task. Load plans from markdown with `/nosleep-init`. |
| **The Brain** | Captures sessions, decisions and thoughts into an org-scoped archive with full-text + vector search (local ONNX embeddings) and a graph view. Agents query it via MCP; the `auto-capture` skill files ACT NOW items at session end. |
| **Hooks** | Claude Code hooks (pre/post tool, prompt, stop, pre-compact) stream activity to the server for live monitoring, token tracking, drift detection and goal re-injection. Installed per project from the dashboard. |
| **Loops & schedules** | Per-project auto-loops (`/nosleep-go`, `/nosleep-pause`) and cron schedules, with a no-progress guard and branch auto-stop. |
| **Org isolation** | Three hard-isolated orgs (projects, memory, alerts, keys never cross). |
| **Budget pacing** | Billing-cycle-aware daily allowance; NORMAL → LEAN → RESTRICTED → PAUSED. |
| **Validation** | Haiku-based completeness check + stub heuristics on session exit; auto-retry (max 2) and auto-advance the tree on success. |
| **Research** | Optional NotebookLM MCP server to offload documentation research to the free Gemini backend. |
| **Clients** | Web dashboard, macOS menu bar app, iOS/Android app (Expo), `nosleep` CLI wrapper, one `nosleep` MCP tool for agents. |
| **OpenCode** | Hooks + auto-capture also work in the OpenCode CLI — see [docs/opencode.md](docs/opencode.md). |

## Get running

### 1. Prerequisites

- **Node.js 22+** (`.nvmrc` pins the tested version; `nvm use` works)
- **Claude Code** installed and logged in (`claude` on your PATH)
- git, and a C/C++ toolchain for native modules if no prebuilt binary matches
  your platform (Xcode CLT on macOS, `build-essential` on Linux)
- Optional: Python 3.11+ for the NotebookLM research server; Xcode / Android
  Studio only if you build the mobile app yourself

### 2. Install

```bash
git clone https://github.com/weareu/nosleep.git
cd nosleep
node scripts/install.mjs
```

The installer is idempotent and only uses Node built-ins. It:

1. checks Node and the `claude` CLI,
2. runs `npm install` for all workspaces,
3. creates `.env` from `.env.example` with a fresh `NOSLEEP_API_KEY` and
   `NOSLEEP_HOOK_SECRET` (existing values are never overwritten),
4. downloads the ~23 MB embedding model into `data/models/` (skip with
   `--skip-models`; semantic search is simply off without it).

### 3. Configure: `npm run setup`

```bash
npm run setup            # interactive; every step is skippable and re-runnable
npm run setup -- --dry-run   # show the planned .env changes, write nothing
npm run doctor           # health check any time
```

The wizard works on macOS, Linux and Windows and walks through:

| Step | Choice | Read more |
|---|---|---|
| 1. Background AI | Claude subscription, **local** (Ollama / LM Studio auto-detected) or OpenRouter, per purpose, with a live test call | [Local / alternative models](docs/deployment.md#local--alternative-models) |
| 2. Brain | auto-distilled thoughts on/off; sleep-time consolidator `on` / `dry-run` / `off` | [Known issues → memory rot](docs/known-issues.md#4-memory-rot-at-scale-open-problem) |
| 3. Research | NotebookLM on/off (Python venv, Chromium, Google login) | [mcp-research](packages/mcp-research/README.md) |
| 4. Agent CLIs | registers the `nosleep` MCP tool, copies skills and slash commands into Claude Code, and offers OpenCode | [MCP](docs/mcp.md) · [CLI & skills](docs/cli.md) · [OpenCode](docs/opencode.md) |
| 5. Mobile | writes `packages/mobile/.env.local` (server URL auto-detected from LAN/Tailscale) and prints the build commands for your OS | [Mobile](docs/mobile.md) |
| 6. Autostart | LaunchAgents / systemd / Task Scheduler | [Deployment](docs/deployment.md#running-as-a-service) |
| 7. Doctor | checks Node, `claude`, `.env`, the model, SQLite, the server and LLM endpoints | [Setup guide](docs/setup.md) |

Full walkthrough with trade-offs: **[docs/setup.md](docs/setup.md)**.

### 4. Run

Foreground (any OS):

```bash
npm run dev:server     # API + WebSocket on :3777
npm run dev:web        # dashboard on :5173
```

Or install it as a background service that starts at login:

```bash
node scripts/install.mjs --service          # add autostart
node scripts/install.mjs --uninstall-service
node scripts/install.mjs --service --dry-run  # show what would be written
```

| OS | Autostart backend | Notes |
|---|---|---|
| macOS | LaunchAgents `com.nosleep.{server,web,watchdog}` | Watchdog restarts a wedged server. Logs: `~/.nosleep/` |
| Linux | systemd user units `nosleep-{server,web}.service` | `loginctl enable-linger $USER` to keep running when logged out. Logs: `journalctl --user -u nosleep-server` |
| Windows | Task Scheduler (`NoSleepServer`, `NoSleepWeb`) at logon | Experimental. WSL2 + the Linux path is recommended. |

Check it: `npm run doctor` (or `curl http://localhost:3777/health`).

### 5. Connect manually (if you skipped setup step 4)

1. **Dashboard** — open <http://localhost:5173>, paste `NOSLEEP_API_KEY`
   from `.env` into Settings.
2. **Claude Code MCP** — give every project the `nosleep` tool:

   ```bash
   claude mcp add --scope user --transport http nosleep http://localhost:3777/api/mcp
   ```

   Loopback calls need no key. From another machine add
   `--header "x-api-key: <NOSLEEP_API_KEY>"`.
3. **Add a project** — in the dashboard (Projects → Add, then *Install hooks*),
   or from inside the project in Claude Code with the `/nosleep-init` skill:

   ```bash
   mkdir -p ~/.claude/skills/nosleep-init ~/.claude/skills/auto-capture ~/.claude/commands
   cp packages/cli/skills/nosleep-init/SKILL.md ~/.claude/skills/nosleep-init/
   cp packages/auto-capture-skill/SKILL.md ~/.claude/skills/auto-capture/
   cp packages/cli/commands/nosleep-*.md ~/.claude/commands/
   ```

4. **Optional: the `nosleep` CLI wrapper** — runs the normal Claude TUI but lets
   NoSleep inject the next task into the same session when one finishes.
   Needs python3, a POSIX OS (macOS/Linux/WSL2), and hooks installed in the
   project. Details: [docs/cli.md](docs/cli.md).

   ```bash
   npm link ./packages/cli     # then: nosleep claude --continue
   ```

### 6. Optional components

**macOS menu bar** — green/red health dot, active session count, open
dashboard, restart server/web, watchdog log:

```bash
tools/menubar/scripts/install.sh   # needs Xcode command line tools (swift)
```

**Mobile app (iOS + Android, beta)** — Expo / React Native. The app finds the
server by probing localhost, an optional configured URL and your phone's LAN
subnet, or you type the URL in Settings. For access
away from home use [Tailscale](https://tailscale.com) (on macOS use the App
Store Tailscale app, not the Homebrew CLI — userspace mode can't accept
inbound connections).

```bash
cd packages/mobile
cp .env.example .env.local        # bundle id, Apple team, EAS project, server URL
npx expo start                    # dev: Expo Go works, minus voice capture + push
npx expo run:ios --configuration Release --device   # standalone iOS build
npx expo run:android --variant release              # standalone Android build
```

All per-developer identity (bundle id, Apple team id, EAS project, an extra
server URL to probe) comes from `packages/mobile/.env.local`, never the repo.
Push notifications need your own EAS project (`npx eas init` →
`EAS_PROJECT_ID`); without one, push is simply skipped. Full guide:
[docs/mobile.md](docs/mobile.md).

**NotebookLM research server** — see
[packages/mcp-research/README.md](packages/mcp-research/README.md).

## Platform support

| Component | macOS | Linux | Windows |
|---|---|---|---|
| Server + MCP + hooks | ✅ daily driver | ✅ | 🧪 beta (WSL2 recommended) |
| Web dashboard | ✅ | ✅ | ✅ (any browser) |
| Autostart service | ✅ LaunchAgents + watchdog | ✅ systemd `--user` | 🧪 Task Scheduler |
| Menu bar / tray app | ✅ native Swift | ❌ use the dashboard | ❌ use the dashboard |
| Mobile app | iOS ✅ · Android 🧪 beta | — | — |
| Agent CLIs | Claude Code ✅ · OpenCode 🧪 | same | same |

The status bar app is macOS-only (AppKit). On Linux/Windows the web
dashboard covers the same controls; a cross-platform tray is welcome as a
contribution.

## Configuration

`.env` at the repo root (created by the installer):

| Key | Default | Purpose |
|---|---|---|
| `PORT` | `3777` | API/WebSocket port |
| `DB_PATH` | `./data/nosleep.db` | SQLite database (WAL mode) |
| `NOSLEEP_API_KEY` | generated | Required `x-api-key` for non-loopback clients. Unset = open dev mode |
| `NOSLEEP_HOOK_SECRET` | generated | Authenticates hook callbacks |
| `NOSLEEP_API_KEY_<ORG>` | — | Optional per-org keys (`PERSONAL`, `WYOBI`, `APPLY`) scoping a client to one org |
| `ANTHROPIC_API_KEY` | — | Only for API-billed accounts; Pro/Max use the CLI login |
| `NOSLEEP_DATA_DIR` | `./data` | Brain storage root |
| `NOSLEEP_LLM_PROVIDER[_BRAIN\|_VALIDATOR\|_RESPONDER\|_VISION]` | `claude` | Route background AI to an OpenAI-compatible endpoint (`openai`) |
| `NOSLEEP_LLM_BASE_URL[_…]`, `NOSLEEP_LLM_MODEL[_…]`, `NOSLEEP_LLM_API_KEY[_…]` | Ollama `:11434/v1` | Endpoint, model and key per purpose |

**Run background AI on local models.** The Brain, the validator and the
question responder use your Claude subscription by default. You can point any
of them at Ollama, LM Studio, llama.cpp, vLLM or OpenRouter, e.g.
`NOSLEEP_LLM_PROVIDER_BRAIN=openai NOSLEEP_LLM_MODEL_BRAIN=qwen2.5:7b-instruct`.
See [docs/deployment.md](docs/deployment.md#local--alternative-models).

Everything NoSleep stores lives in `data/` (database, brain archive, models).
It is gitignored. Back it up with `cp -R data/ backup/` (WAL makes a live copy
safe enough; stop the server for a guaranteed-consistent copy).

## Architecture

```
 Web dashboard · menu bar · mobile app · nosleep CLI
                 │  REST + WebSocket (x-api-key)
                 ▼
 ┌──────────────── NoSleep server (Fastify, :3777) ────────────────┐
 │ sessions · supervision loop · strategy trees · scheduler/loops  │
 │ budget pacer · validator · brain (archive, search, graph)       │
 │ MCP gateway at /api/mcp · hook receiver at /api/hooks/*         │
 └───────────────┬───────────────────────────────────▲─────────────┘
                 │ spawns / supervises               │ hooks + MCP
                 ▼                                   │
        Claude Code / OpenCode sessions in your projects
                 │
            SQLite (WAL) in data/
```

| Package | What it is |
|---|---|
| `packages/server` | Fastify server: API, WebSocket, orchestration, brain, scheduler |
| `packages/shared` | Shared types and constants |
| `packages/web` | React 19 + Vite + Tailwind dashboard |
| `packages/mobile` | Expo / React Native app |
| `packages/mcp-gateway` | The single `nosleep` MCP tool (also served over HTTP) |
| `packages/mcp-brain` | Brain MCP server (`capture_thought`, `search_archive`, …) |
| `packages/mcp-memory`, `packages/mcp-control` | Legacy stdio MCP servers (org-scoped) |
| `packages/mcp-research` | NotebookLM research MCP server (Python) |
| `packages/cli` | `nosleep` CLI wrapper, slash commands, `/nosleep-init` skill |
| `packages/auto-capture-skill` | Session-end capture skill |
| `packages/opencode-plugin` | OpenCode plugin (hooks parity) |
| `tools/menubar` | macOS menu bar app (Swift) |

More: [docs/architecture.md](docs/architecture.md) ·
[docs/api.md](docs/api.md) · [docs/mcp.md](docs/mcp.md) ·
[docs/deployment.md](docs/deployment.md) · [docs/runbook.md](docs/runbook.md)

## Security

- All endpoints require `x-api-key` except `/health`, discovery, and hook
  callbacks (which use `NOSLEEP_HOOK_SECRET`). MCP and a few local-only routes
  are key-exempt **only from loopback**.
- The server listens on `0.0.0.0` so the phone can reach it — keep it on a
  trusted LAN or Tailscale, never expose `:3777` to the internet.
- Sessions default to `supervised` permission mode.
- Report vulnerabilities privately via GitHub security advisories.

## Development

```bash
npm run dev:server                              # tsx watch
npm run dev:web                                 # Vite HMR
npx tsc --noEmit -p packages/server             # type-check one package
npx vitest run packages/server                  # tests (use the Node that built better-sqlite3)
npx vitest run scripts                          # installer tests
```

## Known issues

Read [docs/known-issues.md](docs/known-issues.md) before running this 24/7. The short version:

- **It spends your Claude plan in the background.** Brain extraction and
  validation make headless Claude calls with no daily cap yet.
  You can send it to a local model instead, or set
  `NOSLEEP_BRAIN_DISABLE_TRIAGE=1` to turn the heaviest part off.
- **It adds to your sessions' context:** injected messages, goal
  re-injection and recall on launch.
- **Memory rot at scale is unsolved.** Dedup and sleep-time archiving shrink the
  pile, but nothing yet measures or guarantees retrieval quality as the Brain grows.
- Orgs are fixed to three slots. It's a single machine and single user.
  Windows and Android are beta.

## License

NoSleep is free software under the **GNU Affero General Public License v3.0**
([LICENSE](LICENSE)). You can use, modify and self-host it freely. If you
offer a modified version to others over a network, you must share your
source under the same license.

- Commercial license, support and sponsored features:
  [COMMERCIAL.md](COMMERCIAL.md)
- Contributing (CLA required): [CONTRIBUTING.md](CONTRIBUTING.md)
- Security reports: [SECURITY.md](SECURITY.md)
- Name and logo: [TRADEMARKS.md](TRADEMARKS.md)

Copyright © 2026 Fanie Oosthuysen.
