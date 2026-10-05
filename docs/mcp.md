# NoSleep MCP Tool Reference

The MCP gateway exposes a single tool `nosleep` with action-based dispatch.

```typescript
nosleep({ action: "<name>", params: { ... } })
```

Special actions:
- `action: ""` or `action: "help"` — list every action
- `action: "search", query: "<keyword>"` — find by keyword

## Setup

**Recommended — HTTP (no subprocess per session).** The server hosts the gateway at
`POST /api/mcp`. Register it once for every project:

```bash
claude mcp add --scope user --transport http nosleep http://localhost:3777/api/mcp
```

or in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "nosleep": {
      "type": "http",
      "url": "http://localhost:3777/api/mcp",
      "headers": { "x-nosleep-org": "org_personal" }
    }
  }
}
```

Loopback requests need no key. From another machine add
`"x-api-key": "<NOSLEEP_API_KEY>"` to `headers` (and don't expose `:3777` beyond
your LAN/Tailscale). `x-nosleep-org` sets the default org for calls without a
session context.

**Alternative — stdio.** Runs the gateway as a local process against the same DB:

```json
{
  "mcpServers": {
    "nosleep": {
      "command": "npx",
      "args": ["tsx", "/path/to/nosleep/packages/mcp-gateway/src/index.ts"],
      "env": {
        "DB_PATH": "/path/to/nosleep/data/nosleep.db",
        "NOSLEEP_SERVER_URL": "http://localhost:3777",
        "NOSLEEP_API_KEY": "<NOSLEEP_API_KEY>"
      }
    }
  }
}
```

OpenCode uses the same endpoint — see [opencode.md](opencode.md).

The gateway resolves `org_id` from the current session (via `NOSLEEP_SESSION_ID` env) so most actions don't need an explicit `orgId`.

## Goal & Focus

| Action | Params | Returns |
|--------|--------|---------|
| `goal_get` | `sessionId?` | Current goal, phase, criteria |
| `goal_progress` | `phase`, `progressPct`, `notes?`, `criteriaCompleted?[]` | Updates goal row |
| `focus_check` | `sessionId?` | Goal + open drift warnings |
| `budget_check` | `sessionId?` | `tokens_used / token_budget` |

## Strategy Tree

| Action | Params | Returns |
|--------|--------|---------|
| `strategy_tree` | `projectId?`, `orgId?` | Full ASCII tree |
| `strategy_node` | `nodeId` | Node detail incl. children |
| `strategy_update` | `nodeId`, `status: pending\|in_progress\|completed\|blocked\|skipped` | Status change |
| `strategy_progress` | `nodeId`, `progressPct: 0-100` | Auto-propagates to ancestors |
| `strategy_add` | `parentId`, `type`, `title`, `description?`, `acceptanceCriteria?[]`, `weight?`, `priority?(1=critical..4=low)`, `sourceRef?`, `dependsOn?[{nodeId,type:FS\|SS}]` | Created node |
| `strategy_batch_update` | `nodeIds[]`, `status` | Bulk status change |
| `strategy_skip_children` | `parentId` | Skip all pending children |
| `strategy_delete_children` | `parentId` | Delete children |
| `strategy_next` | `projectId?`, `orgId?` | Next actionable leaf |

## Sessions

| Action | Params | Returns |
|--------|--------|---------|
| `session_launch` | `projectId`, `goal`, `acceptanceCriteria[]`, `strategyNodeId?` | New session id |
| `session_list` | `orgId`, `status?(running\|completed\|failed\|stopped\|all)` | Recent sessions |
| `session_stop` | `sessionId` | Stops process |
| `session_redirect` | `sessionId`, `message` | Sends message to running session |

## Projects

| Action | Params | Returns |
|--------|--------|---------|
| `project_list` | `orgId` | All projects |
| `project_create` | `orgId`, `name`, `path`, `tokenBudget?`, `autonomyLevel?(full\|supervised\|manual)` | New project id |
| `project_update` | `projectId`, `name?`, `tokenBudget?`, `autonomyLevel?` | Updates |
| `project_search` | `projectId`, `query`, `limit?(5)` | Semantic search hits |
| `search_all` | `query`, `limit?(10)` | Cross-project search |

## Alerts & Help

| Action | Params | Returns |
|--------|--------|---------|
| `request_help` | `orgId`, `question`, `urgency?(low\|medium\|high)` | Creates alert (severity by urgency) |
| `alert_list` | `orgId`, `includeAcked?`, `limit?` | Alerts |
| `alert_ack` | `orgId`, `alertId?(omit to ack all)` | Acks |

## Memory (org-scoped)

| Action | Params | Returns |
|--------|--------|---------|
| `memory_store` | `orgId`, `category: skill\|decision\|pattern\|fact`, `key`, `value`, `project?` | New memory id |
| `memory_search` | `orgId`, `query`, `category?`, `project?`, `limit?` | Hits |
| `memory_list` | `orgId`, `category?`, `project?` | All |
| `memory_delete` | `orgId`, `id` | Removed |

## Coordination (multi-session)

| Action | Params | Returns |
|--------|--------|---------|
| `file_lock` | `sessionId?`, `orgId?`, `path` | Lock id |
| `file_unlock` | `sessionId?`, `path` | Released |
| `file_check` | `path`, `orgId?` | Holder info if locked |
| `session_msg` | `orgId`, `type: discovery\|request\|handoff\|conflict\|info`, `message`, `to?` | Posted |
| `session_inbox` | `sessionId?` | Pending messages |
| `session_peers` | `orgId?` | Other active sessions |

## Plans & Scheduling

| Action | Params | Returns |
|--------|--------|---------|
| `plan_ingest` | `projectId`, `orgId?`, `filePath` | Strategy nodes created from `## headings` |
| `schedule_list` | `projectId?`, `orgId?` | Tasks |
| `schedule_create` | `projectId`, `name`, `cronHour`, `cronMinute?`, `daysOfWeek?`, `goalTemplate` | New task |
| `schedule_update` | `id`, `name?`, `cronHour?`, `goalTemplate?`, `enabled?` | Updates |
| `schedule_delete` | `id` | Removed |
| `schedule_run` | `id` | Manual trigger |

## Loops

| Action | Params | Returns |
|--------|--------|---------|
| `loop_stop` | `projectId?` | Disables this project's autonomous loop (use when nothing is left to do) |

Loops are started from the dashboard or `/nosleep-go`; see [cli.md](cli.md).

## Brain

The Brain has two layers: the **archive** (raw captured turns, tool calls, code,
docs) and **thoughts** (distilled, linked notes forming a graph).

| Action | Params | Returns |
|--------|--------|---------|
| `brain_search` | `projectId`, `query`, `kindPrefix?` (csv, e.g. `code/,decision/`), `sessionId?`, `fromTs?`, `toTs?`, `limit?` | Hybrid lexical + semantic archive hits |
| `brain_thoughts_search` | `projectId`, `query`, `scope?(project\|org)`, `limit?(10)` | Matching thoughts |
| `brain_thought_get` | `projectId`, `thoughtId`, `include?(refs,archive)` | One thought + metadata |
| `brain_thought_related` | `projectId`, `thoughtId`, `limit?(10)` | Graph neighbours (refines/supersedes/related) |
| `brain_thought_stats` | `projectId`, `scope?(project\|org)` | Counts by type, top topics/people |
| `brain_capture_thought` | `projectId`, `content`, `typeHint?`, `sourceRefs?(json)` | Captured thought id |
| `brain_ingest_file` | `projectId`, `path?` (inside the project directory; dotfiles refused) or `contentBase64?` + `filename`, `contentType?` | Uploads a document (PDF, Markdown/text, code, data, images; max 10 MB) through `POST /api/brain/ingest/file` — the same pipeline as web upload. The per-org `nosleep-brain-<org>` server exposes the same thing as `ingest_file` |
| `brain_artifact_get` | `projectId`, `hash`, `include?(edges,ingest_event)` | One archive artifact |
| `brain_session_artifacts` | `projectId`, `sessionId`, `limit?(100)`, `order?(asc\|desc)` | A session's captured history |
| `brain_entities` | `projectId`, `kind?`, `order?(ref_count\|name\|recent)`, `limit?(50)` | Extracted people / concepts |

## Conventions

- All actions return human-readable text (markdown). Tool callers parse with regex if structured data is needed.
- Most actions resolve org context from `NOSLEEP_SESSION_ID` env var; pass `orgId` only when no session context exists.
- Errors return descriptive strings, not exceptions.

See [packages/mcp-gateway/src/actions.ts](../packages/mcp-gateway/src/actions.ts) for the source of truth.
