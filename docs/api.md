# NoSleep HTTP API

Base URL: `http://localhost:3777` (or your Tailscale IP).

## Authentication

All endpoints require the `x-api-key` header except those listed below.

```bash
curl -H "x-api-key: $NOSLEEP_API_KEY" http://localhost:3777/api/orgs
```

The key is set via `NOSLEEP_API_KEY` in `.env`.

**Auth-exempt endpoints** (no key required):
- `GET /health`, `GET /health/deep`
- `GET /api/discovery`
- `GET /ws` (WebSocket upgrade)
- `POST /api/hooks/{pre-tool,post-tool,pre-compact,stop}` (hook callbacks)
- `POST /api/sessions/register`, `POST /api/sessions/:id/drain`
- `POST /api/sessions/:id/decide-next` (called by stop hook)

## Response Envelope

```json
{ "success": true, "data": ... }
{ "success": false, "error": "..." }
```

Mobile app's `fetchJson` unwraps `data` automatically.

## Health

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Liveness probe — returns `{status, timestamp, activeSessions}` |
| `GET` | `/health/deep` | Component health: `db_read`, `db_pragma`, `stuck_starting_sessions`, plus uptime + memoryMB |

## Discovery

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/discovery` | Returns `{host, port, apiKeyPrefix}` for HTTP-based discovery |

## Organizations

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/orgs` | List orgs with `projectCount`, `activeSessions`, `unackedAlerts`, `todayTokens` |

## Accounts

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/accounts?orgId=` | List accounts (optionally filtered) |
| `POST` | `/api/accounts` | Create account (`orgId`, `name`, `type`, `dailyTokenLimit`) |

## Projects

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/projects?orgId=` | List projects with org info |
| `GET` | `/api/projects/:id` | Get project + recent sessions |
| `POST` | `/api/projects` | Create (`orgId`, `name`, `path`, `accountId`, `tokenBudget?`, `autonomyLevel?`) |
| `PATCH` | `/api/projects/:id` | Update `name`, `tokenBudget`, `autonomyLevel`, `defaultModel`, `active` |
| `GET` | `/api/projects/:id/iteration` | Get iteration steps |
| `PUT` | `/api/projects/:id/iteration` | Replace iteration steps (must be sequential 1..n) |
| `POST` | `/api/projects/:id/iteration/reset` | Reset to defaults |
| `POST` | `/api/projects/:id/loop` | Toggle auto-loop |
| `GET` | `/api/projects/:id/loop` | Get loop state |

## Sessions

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/sessions?orgId=&status=` | List sessions (LIMIT 100), with `idle_seconds` |
| `GET` | `/api/sessions/:id` | Get session + most recent goal |
| `GET` | `/api/sessions/escalations?orgId=` | Pending escalations across sessions |
| `POST` | `/api/sessions` | Launch new session (`projectId`, `goal`, `acceptanceCriteria[]`, ...) |
| `POST` | `/api/sessions/register` | Auto-register a manual CLI session (no auth) |
| `POST` | `/api/sessions/:id/intervene` | `{action: "stop" \| "redirect", message?}` |
| `POST` | `/api/sessions/:id/respond` | Reply to a pending escalation |
| `POST` | `/api/sessions/:id/fork` | Fork a failed session with `failureMode`, `failureSummary`, `additionalContext` |
| `GET` | `/api/sessions/:id/chain` | Walk parent ancestors + child descendants |
| `GET` | `/api/sessions/:id/terminal?tail=` | Wrapped CLI terminal output (file-backed) |
| `POST` | `/api/sessions/:id/input` | Send text to running session |
| `GET` | `/api/sessions/:id/events?type=&limit=` | Session event log |

## Strategy Trees

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/strategy/tree/:projectId` | Full tree with metrics |
| `GET` | `/api/strategy/tree/:projectId/edges` | Dependency edges for graph viz |
| `GET` | `/api/strategy/tree/:projectId/next` | Next actionable node |
| `GET` | `/api/strategy/org/:orgId` | All trees for an org |
| `GET` | `/api/strategy/node/:id` | Node + children + breadcrumb path |
| `GET` | `/api/strategy/node/:id/children` | Direct children |
| `GET` | `/api/strategy/node/:id/path` | Breadcrumb to root |
| `POST` | `/api/strategy/tree` | Create whole tree from nested spec |
| `POST` | `/api/strategy/node` | Create single node |
| `POST` | `/api/strategy/node/:id/dependency` | Add `{nodeId, type: FS\|SS\|FF\|SF}` |
| `POST` | `/api/strategy/node/:id/skip-children` | Skip all children |
| `POST` | `/api/strategy/batch-update` | Bulk node updates |
| `PATCH` | `/api/strategy/node/:id` | Update title, description, weight, criteria |
| `PATCH` | `/api/strategy/node/:id/status` | `pending \| in_progress \| completed \| blocked \| skipped` |
| `PATCH` | `/api/strategy/node/:id/progress` | `progressPct: 0..100` |
| `PATCH` | `/api/strategy/node/:id/move` | Reparent / reorder |
| `PATCH` | `/api/strategy/node/:id/assign` | Assign to a session |
| `PATCH` | `/api/strategy/reorder` | Reorder siblings under a parent |
| `DELETE` | `/api/strategy/node/:id` | Delete (cascades) |
| `DELETE` | `/api/strategy/node/:id/dependency/:targetId` | Remove dep |
| `DELETE` | `/api/strategy/node/:id/children` | Drop all children |

## Alerts

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/alerts?orgId=&unackedOnly=&limit=50` | List alerts |
| `POST` | `/api/alerts/:id/ack` | Acknowledge one |
| `POST` | `/api/alerts/ack-all?orgId=` | Acknowledge all (optionally per-org) |

## Metrics

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/metrics?windowHours=24&orgId=` | Snapshot: sessions, tokens, drift, escalations, validation outcomes |
| `GET` | `/api/metrics/by-org?windowHours=24` | Session count + tokens + avg duration per org |

## Analytics

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/analytics/tokens` | Token usage time series |
| `GET` | `/api/analytics/tokens/org` | Per-org token totals |
| `GET` | `/api/analytics/budget` | Budget status |
| `GET` | `/api/analytics/pacing` | Current pacing mode + reason |

## Scheduled Tasks

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/scheduled-tasks?orgId=&projectId=` | List |
| `POST` | `/api/scheduled-tasks` | Create |
| `PATCH` | `/api/scheduled-tasks/:id` | Update (incl. `enabled: bool`) |
| `DELETE` | `/api/scheduled-tasks/:id` | Delete |
| `POST` | `/api/scheduled-tasks/:id/run` | Manual trigger (bypasses schedule) |
| `POST` | `/api/scheduled-tasks/seed-defaults` | Seed 4 review tasks per project |

## Coordination

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/coordination/locks?orgId=` | Active file locks |
| `POST` | `/api/coordination/locks` | Acquire lock |
| `DELETE` | `/api/coordination/locks/:id` | Release |
| `GET` | `/api/coordination/messages?orgId=` | Inter-session messages |
| `POST` | `/api/coordination/messages` | Send message |
| `GET` | `/api/coordination/peers?orgId=` | Active peer sessions |

## Hooks

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/hooks/pre-tool` | Hook callback (no auth) |
| `POST` | `/api/hooks/post-tool` | Hook callback (no auth) |
| `POST` | `/api/hooks/pre-compact` | Hook callback (no auth) |
| `POST` | `/api/hooks/stop` | Hook callback (no auth) |
| `GET` | `/api/hooks/status` | Installed hooks |
| `POST` | `/api/hooks/install` | Install hooks (`scope`, `target`) |
| `POST` | `/api/hooks/uninstall` | Uninstall |

## Search

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/search?q=&projectId=` | Vector + FTS hybrid search |
| `GET` | `/api/search/all?q=` | Cross-project |
| `POST` | `/api/search/reindex` | Rebuild project index |

## Push Notifications

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/push/register` | Register Expo push token |
| `DELETE` | `/api/push/unregister` | Unregister |

## System / Research

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/system/stats` | CPU, memory, GPU |
| `GET` | `/api/research/notebooks` | Cached research notebooks |
| `GET` | `/api/research/log` | Research query log |
| `GET` | `/api/research/savings` | Token savings vs cold queries |

## CORS

Origin allowlist is callback-based: any host on ports `5173`, `3777`, or `19006` is permitted (see [server.ts](../packages/server/src/server.ts) `ALLOWED_CORS_PORTS`). Wildcard origin is never used.

## Body Limits

- Global: 1 MB
- Hook callbacks: subject to global limit (~256KB realistic)

## Errors

- `400` — Zod validation failure (returns `error: <zod message>`)
- `401` — missing/invalid `x-api-key`
- `404` — resource not found (also returned as `success:false` 200 on some legacy routes)
- `503` — budget pacer rejected a session launch
