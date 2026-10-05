# NoSleep Architecture

## High-level view

```
┌─────────────────┐         ┌─────────────────┐
│  Web Dashboard  │  HTTP   │   Mobile App    │
│  (React + Vite) │  + WS   │  (Expo / iOS)   │
└────────┬────────┘         └────────┬────────┘
         │                           │
         │      x-api-key auth       │
         └─────────────┬─────────────┘
                       │
         ┌─────────────▼─────────────┐
         │      Fastify Server       │
         │     (port 3777, WAL)      │
         │  ┌──────────────────────┐ │
         │  │ Routes (REST + WS)   │ │
         │  │ Session Manager      │ │
         │  │ Supervision Loop     │ │
         │  │ Budget Pacer         │ │
         │  │ Strategy Tree Mgr    │ │
         │  │ Task Scheduler       │ │
         │  │ Coordinator          │ │
         │  │ Vector Indexer       │ │
         │  │ Event Bus            │ │
         │  └──────────────────────┘ │
         └────┬────────────┬─────────┘
              │            │
        spawn │            │ read/write
              ▼            ▼
     ┌─────────────┐  ┌─────────────┐
     │ Claude CLI  │  │  SQLite     │
     │ (per session)│  │  WAL        │
     └──────┬──────┘  └─────────────┘
            │
            │ MCP stdio
            ▼
     ┌─────────────┐
     │ MCP Gateway │  (single nosleep tool)
     │  (per session)│
     └─────────────┘
```

## Component map

### `packages/server/`
- `server.ts` — wires everything, registers routes, starts LaunchAgent integrations
- `db/schema.ts` — table definitions + idempotent migrations (no migration framework yet)
- `event-bus.ts` — in-process EventEmitter; subscribed by broadcaster, plan ingester, supervision
- `routes/` — REST endpoints
- `orchestrator/`
  - `session-manager.ts` — launch, stop, redirect, status; owns the `activeSessions` Map
  - `supervision-loop.ts` — drift, compaction recovery, retry, escalation
  - `claude-cli.ts` — child_process spawn, stream-json parsing, env handling
  - `hooks-installer.ts` — writes `.claude/settings.json` with NoSleep hooks
- `budget/`
  - `budget-pacer.ts` — per-account pacing modes (NORMAL/LEAN/RESTRICTED/PAUSED)
  - `token-tracker.ts` — input/output/cache token + USD cost recording
- `validator/`
  - `ai-validator.ts` — Haiku-based completeness check
  - `completeness-analyzer.ts` — heuristic + AI combined verdict
  - `retry-handler.ts` — builds retry prompts from validation failures
- `strategy/`
  - `tree-manager.ts` — CRUD + metrics + propagation + dependency resolution
  - `plan-ingester.ts` — markdown `## headings` → strategy nodes
  - `plan-indexer.ts` — file watch + reindex
- `scheduler/task-scheduler.ts` — cron tick, dead-process reaper, past-due clamp
- `coordination/coordinator.ts` — file locks, inter-session messages, peer discovery
- `embeddings/`
  - `embedder.ts` — ONNX MiniLM-L6-v2, returns 384-dim L2-normalized vectors
  - `vector-indexer.ts` — chunk + embed + write to sqlite-vec
- `focus/`
  - `drift-detector.ts` — heuristic drift signals
  - `embedding-drift-detector.ts` — cosine similarity drift (fast, no LLM)
  - `goal-injector.ts` — periodic re-injection
  - `question-responder.ts` — Haiku auto-answer for routine questions
- `websocket/broadcast.ts` — bridges event bus → WS clients
- `events/session-event-store.ts` — persistent session event log

### `packages/web/`
React + Vite + Tailwind. Pages: Dashboard, SessionDetail, Projects, Strategy, Coordination, Alerts, TokenUsage, Metrics.

### `packages/mobile/`
Expo / React Native (iOS focus). Tabs: Dashboard, Projects, Strategy, Alerts, Schedules, Tokens, Metrics, Settings.

### `packages/mcp-gateway/`
Single MCP server exposing the `nosleep` tool with action dispatch. Spawned per Claude session (see `.mcp.json`).

### `packages/mcp-control/` and `packages/mcp-memory/`
Legacy per-org MCP servers — superseded by `mcp-gateway`. Kept for now.

### `packages/shared/`
Type definitions and constants shared across server, web, mobile.

## Session lifecycle

```
   POST /api/sessions
            │
            ▼
   BudgetPacer.canLaunchSession()  ───►  503 if blocked
            │
            ▼
   INSERT INTO sessions (status='starting')
            │
            ▼
   spawnClaudeSession()   ──►  child_process.spawn('claude', ...)
            │                       │
            │                       │  stdout (stream-json)
            │                       ▼
            │                  parseStreamChunk()
            │                       │
            │                       │  emit('text'/'tool_use')
            │                       ▼
            │              SupervisionLoop.onText()
            │                       │
            │                       │  drift check, compaction detect
            │                       │  goal re-inject every N tools
            │                       ▼
            │                 (queue messages)
            │                       │
            │                       ▼
            │              PreToolUse hook drains queue
            │                       │
            │                       │
            ▼                       ▼
   UPDATE status='running'     UPDATE last_activity_at
            │
            │  on exit
            ▼
   AI validator runs (Haiku)  ──►  retry, advance, escalate
            │
            ▼
   UPDATE status='completed'/'failed'/'stopped'
   eventBus.emit('session:exit')
            │
            ▼
   Strategy tree auto-advance (if successful + has next node)
```

## Supervision loop responsibilities

Per-session state in `SupervisionLoop.activeStates: Map<sessionId, SessionState>`:

| Trigger | Action |
|---------|--------|
| Tool call count % N == 0 | Re-inject goal via message queue |
| Output matches compaction patterns | Re-send goal + criteria summary |
| Output similarity to goal < 0.35 (embedding) | Drift alert + optional redirect |
| Question detected (`AskUserQuestion`) | Haiku classifies → continue / next_task / escalate |
| No tool activity for `IDLE_TIMEOUT_MS` | Send "continue or escalate" prompt |
| Process exits | Run AI validator, retry if incomplete, advance strategy tree if complete |

## Hooks integration (push)

Claude CLI calls back into the server at four hook points:

1. **PreToolUse** — Server returns queued messages to inject (goal re-injection, drift redirects, peer notifications, file lock warnings, budget warnings)
2. **PostToolUse** — Server logs tool call to event store, updates `last_activity_at`
3. **PreCompact** — Server captures session state before context compaction
4. **Stop** — Server runs `decide-next` to pick the next strategy node

Hook script: `packages/server/src/orchestrator/hooks-installer.ts` writes a small JS launcher that POSTs to `/api/hooks/<name>`.

## Budget pacing

`BudgetPacer.computePacingMode(accountId)` runs on every launch attempt:

| Tokens used | Mode | Effect |
|-------------|------|--------|
| < 50% daily limit | NORMAL | All launches allowed |
| 50–75% | LEAN | Skip non-priority launches |
| 75–90% | RESTRICTED | Only priority sessions |
| > 90% or > daily | PAUSED | All launches rejected (`503`) |

Velocity-based: also factors in tokens-per-hour vs remaining budget vs reset window.

## Strategy trees

Unlimited depth, self-referencing parent. Status flows up via `StrategyTreeManager.computeMetrics`:
- Leaves contribute their `progressPct` weighted by `weight` (default 1)
- Parent progress = sum(child.progress * child.weight) / sum(child.weight)
- Status: if all children completed/skipped → completed; else if any in_progress → in_progress; else pending

Auto-advancement: on session exit with verdict=complete, the assigned strategy node is marked complete and the next actionable leaf (deps satisfied, status=pending) is launched. Rate-limited to 10/hour.

## Concurrency model

- Server is single-threaded Node.js (better-sqlite3 is synchronous)
- WAL mode allows concurrent reads while one writer holds the lock
- `busy_timeout=5000` for transient contention
- One mutex per scheduler tick — `currentTaskRunning` flag prevents simultaneous scheduled tasks
- Up to 5 concurrent Claude sessions (enforced in session-manager via active count check)

## Data flow: web dashboard receives a session update

```
Claude emits text → claude-cli stream parser
  → SessionManager.onText
    → SupervisionLoop.onText
    → eventBus.emit('session:output', sessionId, text)
       → broadcast('session:output', { sessionId, text: text.slice(-2000) })
          → for each WS client with readyState===OPEN: client.send(payload)
             → web client useWebSocket hook receives
                → React state update
                → re-render
```

## Sessions table (post-org_id refactor)

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  org_id TEXT,                     -- denormalized, indexed
  account_id TEXT,
  pid INTEGER,                     -- null for manual_*, set for managed
  status TEXT,                     -- starting|running|idle|waiting_input|paused|completed|failed|stopped
  goal_text TEXT,
  goal_hash TEXT,
  parent_session_id TEXT,          -- fork chain
  failure_mode TEXT,
  failure_summary TEXT,
  model TEXT,
  cost_usd REAL,
  started_at TEXT,
  last_activity_at TEXT,
  ended_at TEXT,
  tokens_used INTEGER
);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_org ON sessions(org_id);
CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);
```

See [packages/server/src/db/schema.ts](../packages/server/src/db/schema.ts) for the full schema.
