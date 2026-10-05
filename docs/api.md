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

## Uploading documents

`POST /api/brain/ingest/file` — upload one file into the Brain. JSON body, file bytes base64-encoded (the same encoding the mobile photo/voice uploads use on `/api/brain/ingest`). Auth: `x-api-key`; a per-org key may only write to its own `org_id` (403 otherwise).

| Field | Required | Notes |
|-------|----------|-------|
| `filename` | yes | Extension decides the type when recognised (browsers mislabel e.g. `.ts` as `video/mp2t`) |
| `content_type` | no | Used when the extension is unknown |
| `content_base64` | yes | Raw file bytes, base64 |
| `org_id`, `project_id` | yes | Target scope |
| `origin` | no | `{ tool, actor }`, default `{ tool: "brain-upload", actor: "user" }` |

| Type | Stored as | What runs |
|------|-----------|-----------|
| `.pdf` | `document/pdf` (original bytes) + one `document/pdf_excerpt` per page with text, linked by `page_of_document` edges | pdf-parse text layer, per-page FTS + embeddings, one distilled thought per document. No OCR: scanned PDFs are stored with a warning and nothing searchable |
| `.md .markdown` | `document/markdown` | FTS, embeddings, distilled thought |
| `.txt .text .log` | `document/text` | FTS, embeddings, distilled thought |
| `.json`, `.yaml .yml`, `.csv` | `data/json`, `data/yaml`, `data/csv` | FTS |
| Source code (`.ts .tsx .js .jsx .py .go .rs .sql .sh` and `.java .kt .swift .rb .php .c .h .cpp .cs .css .html .xml .toml` …) | `code/blob/<ext>` or `code/blob` | FTS, embeddings, symbol extraction |
| `.png .jpg .jpeg .gif .webp` | `media/image/photo` | Image extractors; caption/OCR via the `vision` LLM route when configured |

Thought distillation and vision use the existing LLM routing (`NOSLEEP_LLM_*`, purposes `brain` and `vision`) and the brain spawn budget. Outcomes, including skips, are recorded in `extractor_runs`.

Limits: 10 MB decoded per file (`BRAIN_INGEST_MAX_BYTES`); the request body limit is 16 MB. Uploads are refused while the disk is below the brain's free-space floor (`NOSLEEP_MIN_FREE_DISK_GB`).

| Status | Meaning |
|--------|---------|
| `202` | Stored: `{ filename, kind, hash, duplicate, size, pages?, page_count?, warnings }` |
| `400` | Missing/invalid fields |
| `403` | Key bound to a different org |
| `413` | Over the size cap, or low disk |
| `415` | Unsupported type; `error.details.supported` lists the accepted types |
| `422` | Bytes don't match the type (invalid base64, not UTF-8, corrupt PDF) |
| `503` | `pdf-parse` not installed on the server |

```bash
curl -X POST http://localhost:3777/api/brain/ingest/file \
  -H "x-api-key: YOUR_API_KEY" -H "content-type: application/json" \
  -d "{\"filename\":\"report.pdf\",\"content_type\":\"application/pdf\",\"org_id\":\"org_personal\",\"project_id\":\"_org_level\",\"content_base64\":\"$(base64 < report.pdf | tr -d '\n')\"}"
```

`POST /api/brain/capture-url` with `mode: "full"` follows the same PDF path when the URL serves `application/pdf`. Capturing intranet or local hosts needs them listed in `NOSLEEP_URL_FETCH_ALLOW_HOSTS` (comma-separated exact hostnames/IPs); private addresses are blocked otherwise.

## CORS

Origin allowlist is callback-based: any host on ports `5173`, `3777`, or `19006` is permitted (see [server.ts](../packages/server/src/server.ts) `ALLOWED_CORS_PORTS`). Wildcard origin is never used.

## Brain Search

`POST /api/brain/search` — one ranked list over **both** brain layers. Body is a QuerySpec (`org_id`, `project_id`, `scope?`, `text?`, `facets?`, `temporal?`, `layers?`, `include_archived?`, `limit?`).

- `layers` defaults to `["archive", "thoughts"]`. Archive artifacts and distilled thoughts are fused into one ranking (reciprocal rank fusion of BM25, semantic and thought-FTS retrievers).
- Each result carries `layer: "archive" | "thoughts"`. For thoughts, `hash` is the thought id and `thought: { id, thought_type, visibility, topics }` is set; `kind` is `thought/<type>`.
- Thoughts honour visibility: only `active` unless `include_archived: true`; merged-away thoughts never appear. Org and project scope apply to both layers.
- Archive-only facets (`kind_prefix`, `origin`, `session_id`, `actor`, `numeric`) turn the query into an archive query (no thoughts).
- Content is stored once (content-addressed), and every project that ingested it can find it. A duplicate upload into a second project returns `duplicate: true` and is still found by that project's search.

## Body Limits

- Global request body: 16 MB (Fastify `bodyLimit`, `packages/server/src/server.ts`) — sized so hook callbacks carrying a large `Read` result or tool output don't 413. Larger bodies get `413`.
- Brain file upload (`POST /api/brain/ingest/file`, MCP `ingest_file` / `brain_ingest_file`): 10 MB of **decoded** file bytes (`BRAIN_INGEST_MAX_BYTES`); base64 inflates that to ~13.4 MB on the wire, which fits under the 16 MB body limit.
- Hook callbacks: subject to the global 16 MB limit.

## Errors

- `400` — Zod validation failure (returns `error: <zod message>`)
- `401` — missing/invalid `x-api-key`
- `404` — resource not found (also returned as `success:false` 200 on some legacy routes)
- `503` — budget pacer rejected a session launch
