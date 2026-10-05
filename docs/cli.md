# `nosleep` CLI Wrapper, Slash Commands & Skills

`packages/cli` ships three things:

| Piece | Path | What it is |
|---|---|---|
| `nosleep` CLI | `packages/cli/nosleep.mjs` + `pty-wrap.py` | Runs the normal interactive `claude` TUI inside a pseudo-terminal so NoSleep can type into it remotely |
| Slash commands | `packages/cli/commands/nosleep-*.md` | `/nosleep-go`, `/nosleep-pause`, `/nosleep-status`, `/nosleep-connect` |
| Skills | `packages/cli/skills/nosleep-init`, `packages/auto-capture-skill` | `/nosleep-init` (load plans into the strategy tree), `auto-capture` (session-end Brain capture) |

The CLI is optional. Hooks + the MCP tool already register and steer plain
`claude` sessions (see `/nosleep-connect` below). Use the wrapper when you want
messages typed into the TUI immediately rather than between turns, and the
next task to start automatically when Claude exits.

## What the wrapper does

```
nosleep claude [claude args...]
  │
  ├─ POST /api/sessions/register        (org read from the project's hook script)
  ├─ spawn: python3 pty-wrap.py .claude/.nosleep-inject <claude> [args...]
  │     ├─ your keystrokes      → claude's PTY
  │     ├─ .claude/.nosleep-inject (FIFO) → claude's PTY, "\n" sent as Enter
  │     └─ claude's output      → your terminal + .claude/.nosleep-inject.log (ANSI-stripped, capped ~100 KB)
  ├─ every 3 s: POST /api/sessions/:id/drain → append message to the FIFO
  └─ on clean exit (code 0): POST /api/sessions/:id/decide-next
```

1. **Registration.** Reads the org id baked into
   `.claude/nosleep-hooks/pre-tool.mjs` (written by *Install hooks* in the
   dashboard) and registers the current directory as a session. The session id
   is exported to Claude as `NOSLEEP_SESSION_ID` and written to
   `.claude/.nosleep-session`. If no project hook script exists it prints
   `[nosleep] No org. Run in a hooked project.` and runs Claude without any
   remote features.
2. **Remote injection.** Anything queued for the session on the server (a
   *Redirect* from the dashboard or mobile app, a scheduler message) is drained
   every 3 seconds and typed into the TUI as if you had entered it. The
   server's `POST /api/sessions/:id/input` endpoint writes straight into the
   same FIFO.
3. **Resume kickoff.** With `--continue` / `--resume` and no prompt, it types a
   short "continue, or call `nosleep(action="strategy_next")`" message 3 s
   after start.
4. **Next task.** When Claude exits with code 0, the server decides (Haiku,
   budget-aware) what happens next:

   | Decision | Wrapper behaviour |
   |---|---|
   | `next_task` | Prints the task, waits 5 s (Ctrl+C cancels), then relaunches `claude --continue "<task + acceptance criteria>"` in the same conversation. The chain is one level deep — after that run exits, the wrapper exits too. |
   | `escalate` | Prints the reason; check alerts on the dashboard / phone |
   | anything else | Prints the action and reason, then exits |

   A non-zero exit (Ctrl+C, crash) skips the decision. On exit the wrapper
   removes `.claude/.nosleep-session` and the FIFO.

The mobile **Terminal** screen does not read `.nosleep-inject.log`; it renders
the session from Brain artifacts and steers through Redirect. The server's
`GET /api/sessions/:id/terminal` endpoint serves the log tail.

## Install

```bash
npm link ./packages/cli        # puts `nosleep` on your PATH
nosleep claude --continue
```

## Usage

```bash
nosleep claude                         # fresh interactive session
nosleep claude "fix the login bug"     # start with a prompt
nosleep claude --continue              # resume the last conversation (+ auto kickoff)
nosleep --resume <id>                  # the leading `claude` word is optional
```

All arguments after the optional `claude` word go to `claude` unchanged. The
wrapper has no flags of its own.

Run it from the **project root**, the folder whose `.claude/` holds the hooks.
The FIFO lives at `.claude/.nosleep-inject`. If `.claude/` is missing, the PTY
helper cannot create it and Claude does not start. Run only one wrapper per
folder because two wrappers would share one FIFO.

## Environment

| Variable | Default | Used for |
|---|---|---|
| `NOSLEEP_SERVER_URL` | `http://localhost:3777` | Server base URL for register / drain / decide-next |
| `NOSLEEP_API_KEY` | empty | Sent as `x-api-key`. Loopback needs none; set it when the server is on another machine |
| `HOME` | — | Looks for `~/.local/bin/claude` first |
| `NOSLEEP_SESSION_ID` | *(set by the wrapper)* | Exported to Claude and its hooks |
| `CLAUDECODE` | *(removed)* | Unset so `claude` starts as a top-level session even from inside another Claude Code shell |

The `claude` binary is resolved from `~/.local/bin/claude`, then
`/usr/local/bin/claude` and `/opt/homebrew/bin/claude`, then `which claude`.

## Requirements & platform support

- Node.js 18+ (`fetch`, `AbortSignal.timeout`)
- `python3` on `PATH` (standard library only: `pty`, `termios`, `fcntl`, `select`)
- The NoSleep server running and the project's hooks installed

| Platform | Status |
|---|---|
| macOS | Works, used daily |
| Linux | Expected to work because `pty-wrap.py` is plain POSIX (`pty.fork`, `os.mkfifo`, termios), but it gets less testing |
| Windows (native) | **Not supported.** Python's `pty`/`termios`/`fcntl` and FIFOs are POSIX-only. Use WSL2, or skip the wrapper and use `/nosleep-connect` |

## Slash commands

Install them for every project:

```bash
mkdir -p ~/.claude/commands
cp packages/cli/commands/nosleep-*.md ~/.claude/commands/
```

Each command only writes or reads small state files under the project's
`.claude/`. The hooks and server act on those files.

| Command | What it does | State file |
|---|---|---|
| `/nosleep-go [delay]` | Turns on the auto-loop and auto-connects the session. With no argument or `0`, the Stop hook injects the next strategy-tree task into this session as soon as one finishes. With a delay (`15m`, `2h`, `90m` or bare minutes, clamped to 0 to 10080), the session ends cleanly and NoSleep schedules a one-shot wake that launches a fresh session N minutes later. Then it calls `strategy_next` and starts work. | `.claude/.nosleep-loop-active` (`{"delayMinutes":N}`), `.claude/.nosleep-connected` |
| `/nosleep-pause` | Turns off the auto-loop. The session stops after the current task. | removes `.claude/.nosleep-loop-active` |
| `/nosleep-status` | Shows loop on/off, the hook tool-call count, the last task and the `strategy_next` preview | reads `.nosleep-loop-active`, `.nosleep-tool-count`, `.nosleep-last-task` |
| `/nosleep-connect` | Opts this running session into dashboard/mobile monitoring and steering without wrapping or spawning anything. Steering messages are queued on the server and injected by the Stop hook between turns. Delete the file to disconnect. | `.claude/.nosleep-connected` |

The loop can also be toggled remotely with `POST /api/projects/:id/loop`
(`{"enabled": true|false}`), which writes or removes the same
`.nosleep-loop-active` file. For recurring cron-style runs, use the dashboard's Schedules tab instead.

## Skills

Install by copying each skill folder to `~/.claude/skills/<name>/`. The folder
name must match the skill's `name:`.

```bash
mkdir -p ~/.claude/skills
cp -r packages/cli/skills/nosleep-init ~/.claude/skills/nosleep-init
cp -r packages/auto-capture-skill     ~/.claude/skills/auto-capture
```

### `nosleep-init`

Registers the current project and loads its plan documents into the live
strategy tree. The rule it enforces: a strategy that exists only as markdown is
not done. Done means the tree is visible in the dashboard.

1. `project_list` across orgs. The org is chosen by who owns the work, not by
   directory.
2. `project_create` if missing (default `tokenBudget: 500000`,
   `autonomyLevel: "supervised"`, unless the doc has a "Project config" block).
3. Finds `docs/strategy/*.md`, `docs/plans/*.md` and `PLAN.md`. Flat plans
   (`##` = task) go through `plan_ingest`. Nested hierarchies go in one
   `POST /api/strategy/tree` call. Tags are mapped as follows: ✅ to completed,
   🔴 to blocked, 🟢 to `priority: true`, and "after X" to an FS dependency.
4. Verifies with `strategy_tree` + `strategy_next`, which must return a real
   task.

It needs the `nosleep` MCP tool configured in Claude Code
(`claude mcp add --scope user --transport http nosleep http://localhost:3777/api/mcp`)
and, only for bulk REST tree creation, `NOSLEEP_API_KEY` in the environment.

### `auto-capture`

A behavioural protocol, not a background hook. When a session is clearly
ending ("wrap up", "park this", "let's stop here", or a supervision
`session_end` event), Claude:

- runs `search_thoughts` first to skip duplicates,
- captures each ACT NOW item as its own `capture_thought` (with why it matters
  and 2–3 next actions, a `thought_type_hint`, and `source_refs` when an
  artifact drove it),
- captures one session summary,
- skips raw transcript, parked items and duplicates, and reports honestly if a
  capture fails.

It uses the `capture_thought` / `search_thoughts` tools on the
`nosleep-brain-<org>` MCP server. *Install hooks* from the dashboard also
copies this skill into the project's `.claude/skills/`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `[nosleep] No org. Run in a hooked project.` | No `.claude/nosleep-hooks/pre-tool.mjs` in the current directory. Install hooks for the project (dashboard → Projects → *Install hooks*) and run from the project root |
| Claude never starts and Python prints a `mkfifo` / `FileNotFoundError` traceback | `.claude/` does not exist in the current directory |
| Phone redirects never arrive | The session did not register (see above), or `NOSLEEP_SERVER_URL` / `NOSLEEP_API_KEY` point to the wrong server. The wrapper ignores API errors without printing them |
| `python3: command not found` | Install Python 3. The wrapper calls `python3` from `PATH` |
| Garbled terminal after a crash | The PTY helper restores the tty on exit. If it was killed with `-9`, run `reset` |
