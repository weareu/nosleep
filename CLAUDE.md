# NoSleep - Autonomous Claude Code Orchestrator

## What This Is
NoSleep orchestrates Claude Code sessions autonomously — launches, supervises, re-injects goals after compaction, detects drift, validates completeness, retries on failure, and advances strategy trees. Dashboard + mobile app for monitoring.

## Division of Labor vs Claude Code Agent Teams (2026-07)
Claude Code now ships in-session multi-agent primitives (Agent Teams, nested
subagents, per-agent cost attribution). NoSleep does NOT compete with those —
inside a session, delegation belongs to teams/subagents (loop and review
prompts encourage it). NoSleep's layer is what Claude Code doesn't have:
CROSS-project cadence (loops, crons, wakes), durable strategy trees, org
isolation, the brain (capture + recall across sessions), budget pacing, and
remote control (dashboard/mobile). Rule of thumb: parallelism WITHIN a task →
Agent SDK/teams; persistence, scheduling, and memory ACROSS tasks/projects →
NoSleep.

## Architecture
- **Monorepo**: npm workspaces — `packages/server`, `packages/web`, `packages/mobile`, `packages/shared`, `packages/mcp-control`, `packages/mcp-memory`
- **Server**: Fastify + SQLite (WAL mode) on port 3777
- **Web**: React + Vite + Tailwind on port 5173
- **Mobile**: Expo/React Native (iPhone)
- **MCP**: 6 servers (control + memory per org), org-scoped via `NOSLEEP_ORG_ID`

## Organization Isolation
Orgs are USER-DEFINED with HARD boundaries. The `organizations` table is the single source of truth (id `org_<slug>`, slug `[a-z0-9-]`, name, colour); fresh installs seed only **Personal** (`org_personal`, the undeletable default). Create/rename/delete via the dashboard (Settings → Organizations), `POST/PATCH/DELETE /api/orgs`, the MCP `org_list`/`org_create` actions, or the setup wizard — delete is refused (409) while an org still owns data. Each org has its own accounts, projects, memory, alerts, brain. Memory never leaks across orgs. Never hard-code an org list or colour in code — read `/api/orgs` (shared helpers in `packages/shared/src/orgs.ts`).

## Key Files
- `packages/server/src/server.ts` — main server, wires all components
- `packages/server/src/orchestrator/session-manager.ts` — session lifecycle
- `packages/server/src/orchestrator/supervision-loop.ts` — autonomous supervision
- `packages/server/src/orchestrator/claude-cli.ts` — Claude CLI wrapper
- `packages/server/src/validator/completeness-analyzer.ts` — AI validation (Haiku)
- `packages/server/src/budget/budget-pacer.ts` — token pacing
- `packages/server/src/strategy/tree-manager.ts` — strategy tree CRUD + metrics
- `packages/mcp-control/src/index.ts` — control MCP server (all tools)
- `packages/mcp-memory/src/index.ts` — memory MCP server

## MCP Servers (configured in .mcp.json)
Each org gets two servers:
- `nosleep-control-{org}` — goal, focus, budget, strategy tree, session, project, alert management
- `nosleep-memory-{org}` — org-scoped memory store/retrieve/list/delete

## Running
Both server and web dashboard auto-start on boot via LaunchAgents:
- `com.nosleep.server` → port 3777
- `com.nosleep.web` → port 5173

## Database
SQLite at `data/nosleep.db`. Key tables: organizations, accounts, projects, sessions, goals, strategy_nodes, alerts, token_usage, memory, push_devices.

## API Authentication
All endpoints require `x-api-key` header. Key is in `.env` as `NOSLEEP_API_KEY`. Exempt: `/health`, `/api/discovery`, `/ws`, `/api/hooks/*`.

## Session Flow
1. Launch via API or MCP `session_launch`
2. Budget pacer checks pacing mode (NORMAL/LEAN/RESTRICTED/PAUSED)
3. Claude CLI spawned with goal prompt + MCP env vars
4. Supervision loop monitors: goal injection, drift detection, compaction recovery
5. On exit: completeness validator runs (AI + heuristic)
6. On success: auto-advance strategy tree. On failure: auto-retry (max 2).

## Supervision Loop Features
- Goal re-injection every N tool calls
- Drift detection (debounced, compares output to goal)
- Context compaction recovery (re-sends goal after Claude compacts)
- Auto-continue on questions (sends "continue autonomously")
- Auto-retry on validation failure
- Strategy tree auto-advancement on completion
- Rate limiting: max 5 concurrent sessions, 10 auto-advances/hour

## Development
```bash
npm run -w @nosleep/server dev   # Server with hot reload
npm run -w @nosleep/web dev      # Dashboard with HMR
npx tsc --noEmit -p packages/server   # Type check a package (repeat per package;
                                      # the ROOT tsconfig has drifted — bare
                                      # `npx tsc --noEmit` shows ~10 false errors)
# Tests: run under the LaunchAgent's Node (native better-sqlite3 ABI):
#   PATH="$HOME/.nvm/versions/node/v24.11.0/bin:$PATH" npx vitest run packages/server
```
