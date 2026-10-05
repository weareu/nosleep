# NoSleep with OpenCode

NoSleep tracks and steers [OpenCode](https://opencode.ai) sessions through the
same server endpoints the Claude Code hooks use. A single OpenCode plugin plays
the part of the generated `.claude/nosleep-hooks/*.mjs` scripts. Verified
against OpenCode **1.18.34**.

## Setup

The existing hooks installer has an `opencode` target, so the dashboard and the
API install for both CLIs:

```bash
# Explicit targets
curl -X POST localhost:3777/api/hooks/install -H "x-api-key: $NOSLEEP_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"scope":"project","projectId":"<id>","targets":["claude","opencode"]}'
```

When `targets` is omitted, NoSleep installs Claude Code, and adds OpenCode only
if the project already has OpenCode config (`.opencode/`, `opencode.json` or
`opencode.jsonc`). A project without OpenCode gets no `.opencode/` directory.
`GET /api/hooks/status` reports `opencodeInstalled` for each project.
`POST /api/hooks/uninstall` removes both targets.

The OpenCode target writes these files, all under `<project>/.opencode/`:

| File | Purpose |
| --- | --- |
| `plugins/nosleep.js` | The plugin (source: `packages/opencode-plugin/nosleep.js`). OpenCode loads it at startup. |
| `nosleep.json` | The org, server URL and project path baked in at install time. |
| `commands/nosleep-{go,pause,status,connect}.md` | The `/nosleep-*` commands. Claude-only frontmatter (`allowed-tools`, `argument-hint`) is removed. |
| `skills/auto-capture/SKILL.md` | The auto-capture skill, from the same package as `.claude/skills`. |
| `opencode.json` | Merges in `mcp.nosleep` as `{type:"remote", url:".../api/mcp", headers:{"x-nosleep-org":<org>}}`. A file that won't parse, such as JSONC with comments, is left untouched. |

### Environment

Environment variables take priority over `nosleep.json`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `NOSLEEP_URL` | `http://localhost:3777` | Server base URL |
| `NOSLEEP_ORG_ID` | from `nosleep.json`, else `org_personal` | Org sent on register. The server still assigns the session to the project's real org based on its path. |
| `NOSLEEP_HOOK_SECRET` | none | Sent as the `x-hook-secret` header, the same as the Claude hooks |
| `NOSLEEP_SESSION_ID` | none | Uses a fixed session id, for sessions NoSleep orchestrates |
| `NOSLEEP_BRAIN_INTERNAL=1` | none | Turns the plugin off (headless brain calls) |

### Global install (optional)

To track OpenCode in every folder, copy `packages/opencode-plugin/nosleep.js` to
`~/.config/opencode/plugins/nosleep.js`. With no `nosleep.json` next to it, the
plugin registers the git worktree, or the cwd outside a repo. The server then
matches the session to a project by path, or files it under the org's "Ad-hoc
sessions" project.

## Event mapping

| OpenCode | NoSleep endpoint | Claude Code equivalent |
| --- | --- | --- |
| first hook in a session | `POST /api/sessions/register` (`claudeSessionId` = OpenCode `sessionID`, `agent:"opencode"`) | every hook's `_sid()` |
| `tool.execute.before` | `POST /api/hooks/pre-tool` | PreToolUse |
| `tool.execute.after` | `POST /api/hooks/post-tool` | PostToolUse |
| `chat.message` (user text parts) | `POST /api/brain/hook-ingest/user-prompt` | UserPromptSubmit |
| `experimental.session.compacting` | `POST /api/hooks/pre-compact` | PreCompact |
| `event` → `session.idle` | `/drain`, `/api/hooks/stop`, `/decide-next`, `/schedule-wake` | Stop |

OpenCode tool ids are converted to the Claude names the server checks for:
`bash→Bash`, `read→Read`, `edit/multiedit/patch/apply_patch→Edit`,
`write→Write`, `glob→Glob`, `grep→Grep`, `task→Agent`, and so on. `filePath`
is also sent as `file_path`. MCP and custom tools keep their names. This keeps
the Edit/Write file-lock warnings and the loop's real-tool counter working.

**Supervision messages** are the `message` field of the pre-tool response:
budget warnings, goal and queue injections, and the coordination inbox. The
plugin queues them per session and appends them to the system prompt of that
session's next model call through `experimental.chat.system.transform`. If a
session compacts first, the queued messages go into the compaction context so
they are not lost.

**Steering**: for a connected session (`/nosleep-connect` or `/nosleep-go`),
a message drained on `session.idle` is sent as a new user turn through the
OpenCode SDK client (`client.session.prompt`). This does the same job as the
Claude Stop hook's `{decision:"block"}`.

**Shared state**: the plugin reads and writes the same `.claude/.nosleep-*`
files as the Claude hooks and the `/nosleep-*` commands (`loop-active`,
`connected`, `tool-count`, `last-task`). The commands therefore work unchanged
in both CLIs.

**Fail-open**: every request has a 3–15 s timeout, and every hook catches its
own errors. If the NoSleep server is down, OpenCode keeps running normally. A
failed register is retried on the next hook rather than cached.

## What works (smoke-tested with real `opencode run`)

These were checked against OpenCode 1.18.34 and a local capture server:

- The plugin loads from `.opencode/plugins/`.
- `register`, `user-prompt`, `pre-tool` (`toolName:"Bash"`) and `post-tool`
  (string `toolResult`) all fire with the expected payloads.
- A pre-tool `message` reached the model through the system prompt. The model
  obeyed an injected marker instruction.
- `opencode debug config` showed the `mcp.nosleep` remote entry, all four
  `/nosleep-*` commands and the plugin.
- The OpenCode server's `/skill` and `/api/skill` endpoints list
  `.opencode/skills/auto-capture`.

The idle, steering, loop and compaction paths have unit tests with a fake
fetch and client. They were not exercised live.

## Differences from Claude Code

| Area | Claude Code | OpenCode |
| --- | --- | --- |
| Transcript ingest into the brain | Stop hook posts `transcript_path` (JSONL) | **Not supported.** OpenCode has no transcript file. User prompts and tool calls reach the brain, but assistant turns do not. |
| Supervision message delivery | Printed by the hook before the tool runs | Added to the system prompt of the next model call, one step later |
| `AskUserQuestion` auto-answer | Server answers through the pre-tool response | Not mapped. OpenCode's `question` tool blocks on the user, and an answer injected into the next system prompt would arrive too late. |
| Loop wake (`/nosleep-go Nm`) | Session ends, and the scheduler relaunches a fresh session later | The plugin calls the same `schedule-wake`, but the scheduler's launcher starts **Claude Code**, not OpenCode. A looping OpenCode project therefore continues in Claude Code. |
| Compaction summary | `summary` (if any) is sent to pre-compact | The hook fires before the summary exists, so it sends no `summary`. The server logs `compaction_detected` only. |
| Goal re-injection via stdin | The supervision loop writes to a wrapped Claude process | Not available. NoSleep does not spawn OpenCode, so it can't re-inject goals through stdin. The system-prompt path above covers queued messages. |
| Orchestrated launch (`session_launch`) | Spawns `claude` | Claude only |
| Global "register every session" hook | `installGlobalHooks` writes it to `~/.claude/settings.json` | Manual copy to `~/.config/opencode/plugins/` (see above) |

## Notes and verified facts

These were checked against the docs at opencode.ai/docs and the installed
1.18.34 binary and types (`@opencode-ai/plugin`):

- Plugin directories are `.opencode/plugins/` and
  `~/.config/opencode/plugins/`. Singular directory names also work.
- Every exported function in a plugin file is treated as a plugin. This comes from the loader's known behaviour and was not tested separately. That's why
  `nosleep.js` exports exactly one function.
- The hook signatures used here are `tool.execute.before(input{tool,sessionID,callID}, output{args})`,
  `tool.execute.after(input{tool,sessionID,callID,args}, output{title,output,metadata})`,
  `chat.message(input{sessionID}, output{message,parts})`,
  `experimental.chat.system.transform(input{sessionID?}, output{system[]})`,
  `experimental.session.compacting(input{sessionID}, output{context[],prompt?})`,
  and `event({event})` with `session.idle`/`session.compacted` carrying
  `properties.sessionID`.
- `.opencode/opencode.json` is loaded as project config. This was checked with
  `opencode debug config`.
- Skills are discovered in `.opencode/skills`, `.claude/skills` and
  `.agents/skills`, both project and global, at least by the v1 `/skill`
  endpoint. The v2 `/api/skill` catalog listed only `.opencode/skills`, which
  is why the installer writes the skill there. When the same skill name
  appears in two locations, OpenCode keeps a single entry and the `.opencode`
  copy wins.
- `opencode debug skill` lists only global skills. To see project skills, use
  the server's `/skill` endpoint.
- OpenCode may create `.opencode/package.json` and `node_modules/` on its own
  (`bun install`). They don't belong to NoSleep, and uninstall leaves them in
  place.
