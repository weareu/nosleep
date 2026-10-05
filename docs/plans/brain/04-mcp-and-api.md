# NoSleep Brain — MCP Tools & REST API

> Authoritative contract for everything that writes to or reads from the brain.

## Auth model

- **REST API**: `x-api-key` header (existing NoSleep `NOSLEEP_API_KEY`). Org inferred from key mapping in `catalog.db.api_keys`. `project_id` required per request.
- **MCP**: `nosleep-brain-<org>` server spawned per-org via `NOSLEEP_ORG_ID` env var (matches existing control + memory server pattern). `project_id` passed per-tool-call; org is fixed by server identity.
- **Hooks**: authenticated via session-token embedded in hook installer config (existing pattern).

## Org/project scoping rules (absolute)

1. Every row in archive, thoughts, entities, entity_refs, metrics, events carries `org_id` + `project_id`.
2. `project_id = '_org_level'` is a sentinel for org-wide items. Never NULL.
3. Cross-org queries/edges/writes: rejected at API level and at trigger level (`trg_edges_no_cross_org`).
4. `scope='org'` expands to "all active projects in this org" — never crosses org lines.
5. Mobile/web clients receive an org-scoped session token; server reconfirms on every request.

## REST API

Base URL: `http://nosleep.local:3777/api/brain`

### Ingest

```
POST /api/brain/ingest
Body:
{
  "kind": "conversation/turn/assistant_message",
  "content": "<base64 or utf-8 text>",
  "content_type": "text/markdown",
  "project_id": "proj_auth_rewrite",
  "session_id": "sess_9f12",
  "turn_ord": 47,
  "origin": {"tool": "claude-code", "version": "2.1.72", "actor": "agent_sonnet"},
  "edges": [
    {"to_hash": "<parent_turn_hash>", "relation": "turn_follows_turn"}
  ],
  "kind_specific_meta": {
    "model": "sonnet-4.6",
    "token_in": 1200,
    "token_out": 340
  },
  "schema_version": 1
}

→ 202 Accepted
{
  "hash": "abc123...",
  "duplicate": false,
  "enqueued": ["embedding_text", "metadata_llm"]
}
```

Constraints:
- `content` size ≤ 10 MB (larger → reject; caller must chunk).
- `kind` must match taxonomy (unknown top-level branch → reject; unknown leaf → accept + queue review).
- `project_id` verified against caller's org.

Idempotency: same `content` → same `hash` → 202 with `duplicate: true` (no re-enqueue).

### Capture thought (direct, bypasses MCP)

```
POST /api/brain/thoughts
Body:
{
  "content": "Decided to switch JWT verification to ES256",
  "project_id": "proj_auth_rewrite",
  "source_kind": "web_ui",
  "source_refs": [
    {"hash": "abc123...", "relation": "decided_in"}
  ],
  "thought_type_hint": "decision",
  "strategy_node_ref": "node_01HXX"
}

→ 201 Created
{
  "id": "01H...",
  "enqueued_extractors": ["metadata_llm", "embedding_text", "entity_resolver"],
  "similar_existing": [
    {"id": "01G...", "content": "...", "cosine": 0.88}
  ]
}
```

Search-before-capture dedup: runs a quick semantic search (Phase 3+); returns up to 3 near-matches in `similar_existing` so caller can inform user. Captures anyway unless caller passes `fail_if_similar_over: 0.95`.

### Capture URL

```
POST /api/brain/capture-url
Body:
{
  "url": "https://blog.example.com/jwt-best-practices",
  "project_id": "proj_auth_rewrite",
  "mode": "full",
  "note": "Good section on ES256 rotation",
  "tags": ["jwt", "auth"]
}

→ 202 Accepted
{
  "link_hash": "...",
  "fetch_enqueued": true,
  "thought_id": "01H..."         // only if note provided
}
```

Fetch completes async. Client polls `/api/brain/artifacts/:hash` or subscribes to event stream.

### Search

```
POST /api/brain/search
Body: <QuerySpec JSON — see 03-query-spec.md>

→ 200 OK
{
  "query_id": "...",
  "latency_ms": 142.7,
  "confidence_score": 0.68,
  "results": [...],
  ...
}
```

### Read artifact

```
GET /api/brain/artifacts/:hash?include=edges,derived_thoughts,entity_refs

→ 200 OK
{
  "hash": "abc123...",
  "kind": "conversation/turn/assistant_message",
  "project_id": "proj_auth_rewrite",
  "ts": 1739520000,
  "content": "...",
  "content_type": "text/markdown",
  "origin": {"tool": "claude-code", "version": "...", "actor": "..."},
  "kind_specific_meta": {...},
  "edges": {
    "incoming": [{"from_hash": "...", "relation": "turn_follows_turn"}],
    "outgoing": [{"to_hash": "...", "relation": "turn_produced_image"}]
  },
  "derived_thoughts": [{"id": "01H...", "relation": "decided_in"}],
  "entity_refs": [{"entity_id": "ent_...", "kind": "topic", "canonical_name": "auth-middleware"}],
  "ingest_event": {...},
  "extractor_runs": [{...}]
}
```

`include` is comma-sep; default returns just the artifact row.

### Read thought

```
GET /api/brain/thoughts/:id?include=refs,archive_refs,entity_refs

→ 200 OK
{
  "id": "01H...",
  "content": "...",
  "metadata": {"type": "decision", "topics": [...], "people": [...], "action_items": [...], "dates_mentioned": [...]},
  "source_kind": "auto_capture_skill",
  "source_refs": [...],
  "strategy_node_ref": "node_...",
  "created_at": 1739520000,
  "visibility": "active",
  "thought_refs": {
    "outgoing": [{"to_thought_id": "...", "relation": "refines"}],
    "incoming": [{"from_thought_id": "...", "relation": "supersedes"}]
  },
  "archive_refs": [{"archive_hash": "...", "relation": "distilled_from"}],
  "entity_refs": [...]
}
```

### List recent thoughts

```
GET /api/brain/recent?project_id=X&since=<ts>&limit=50&type=decision&layer=thoughts

→ 200 OK
{
  "items": [...],
  "cursor": "..."
}
```

Cursor-based pagination.

### Session artifacts

```
GET /api/brain/sessions/:session_id/artifacts?order=ts&limit=100&cursor=

→ 200 OK { items: [...], cursor: "..." }
```

Streamed / paginated because sessions can have 10K+ artifacts.

### Graph data (D3)

```
GET /api/brain/graph?project_id=X&layers=thoughts,entities&since=<ts>&limit=500

→ 200 OK
{
  "nodes": [
    {"id": "01H...", "kind": "thought", "thought_type": "decision", "label": "...", "x": null, "y": null},
    {"id": "ent_...", "kind": "entity", "entity_kind": "topic", "label": "auth-middleware"}
  ],
  "edges": [
    {"from": "01H...", "to": "ent_...", "relation": "mentions", "weight": 1.0},
    {"from": "01H...", "to": "01G...", "relation": "refines", "weight": 0.8}
  ],
  "ppr_hints": {                        // pre-computed cluster centers for seed layout
    "01H...": {"cx": 0.2, "cy": 0.3}
  }
}
```

### Entities

```
GET /api/brain/entities?project_id=X&kind=topic&order=frequency&limit=50
GET /api/brain/entities/:id?include=refs,related
POST /api/brain/entities/:id/aliases { "alias": "JWT" }
POST /api/brain/entities/:id/merge-into { "target_entity_id": "ent_..." }  // lazy: sets merged_into
```

### Metrics

```
GET /api/brain/metrics?metric_key=tokens.input&project_id=X&from=<ts>&to=<ts>&resolution=1h

→ 200 OK { points: [{ts, value, count?, avg?, p95?}], resolution: "1h" }
```

### Events

```
GET /api/brain/events?event_table=ingest|extractor|hook|session|query&from=<ts>&to=<ts>&filters=...
```

### Query logs

```
GET /api/brain/query-logs?from=<ts>&to=<ts>&filters=...
GET /api/brain/query-logs/:query_id              (full pipeline explanation)
PATCH /api/brain/query-logs/:query_id { "used_ids": [...] }    (post-hoc engagement signal)
```

### Admin

```
GET /api/admin/brain/health
GET /api/admin/brain/storage
POST /api/admin/brain/verify-file { "file_name": "sealed-2026-Q1.db" }
POST /api/admin/brain/ppr-recompute { "project_id": "..." }
POST /api/admin/brain/seal-now
GET /api/admin/brain/config
POST /api/admin/brain/config { ...tunables... }
GET /api/admin/brain/export/:session_id     (tarball stream)
POST /api/admin/brain/projects/:id/visibility { "visibility": "hidden", "reason": "..." }
```

### WebSocket (live)

```
WS /ws/brain/live?project_id=X
```

Stream of `{type, artifact, ts}` envelopes for ingest_events, extractor_runs, session events. Filtered by project + layer.

## MCP tool contracts

Server name: `nosleep-brain-<org_id>` (e.g. `nosleep-brain-personal`).

### Core (Nate-aligned)

#### `capture_thought`

```json
{
  "name": "capture_thought",
  "description": "Save a thought (decision, insight, note, action) to the brain for the current project. Returns the thought id and any similar existing thoughts for dedup awareness.",
  "inputSchema": {
    "content": "string — the thought content, standalone and self-contained",
    "project_id": "string — required",
    "source_refs": "array of {hash, relation} — optional archive references",
    "thought_type_hint": "string — optional: observation|task|idea|reference|person_note|decision|insight|question",
    "strategy_node_ref": "string — optional: link to forward-plan node"
  }
}
```

Returns: `{id, similar_existing: [...]}` with the captured thought's id + similar matches.

#### `search_thoughts`

```json
{
  "name": "search_thoughts",
  "description": "Semantic search over captured thoughts. Returns top matches with metadata.",
  "inputSchema": {
    "query": "string — what to search for",
    "project_id": "string — required",
    "limit": "number — default 10",
    "threshold": "number — cosine floor, default 0.5",
    "scope": "string — 'project'|'org', default 'project'"
  }
}
```

Returns top matches with content + metadata (type, topics, people, action_items, dates_mentioned) + similarity.

#### `list_thoughts`

```json
{
  "name": "list_thoughts",
  "description": "List recent thoughts with optional filters.",
  "inputSchema": {
    "project_id": "string — required",
    "limit": "number — default 10",
    "type": "string — filter by thought_type",
    "topic": "string — filter by topic tag",
    "person": "string — filter by person mentioned",
    "days": "number — only last N days"
  }
}
```

#### `thought_stats`

```json
{
  "name": "thought_stats",
  "description": "Aggregated statistics: counts by type, top topics, people mentioned.",
  "inputSchema": {
    "project_id": "string — required",
    "scope": "string — 'project'|'org', default 'project'"
  }
}
```

### Our extensions

#### `get_thought`

```json
{
  "name": "get_thought",
  "description": "Fetch full thought with all refs (thought_refs, archive_refs, entity_refs).",
  "inputSchema": {"id": "string"}
}
```

#### `related_thoughts`

```json
{
  "name": "related_thoughts",
  "description": "Find thoughts related via explicit edges, entity co-occurrence, shared sessions, or shared topics.",
  "inputSchema": {
    "id": "string",
    "limit": "number — default 10",
    "modalities": "array — subset of ['edges', 'entities', 'session', 'topics'] — default all"
  }
}
```

#### `promote_artifact`

```json
{
  "name": "promote_artifact",
  "description": "Promote an archive artifact into a thought with its content + source_refs back to the archive.",
  "inputSchema": {
    "archive_hash": "string",
    "project_id": "string",
    "thought_type_hint": "string — optional",
    "relation": "string — how thought relates to archive: distilled_from|summarizes|quoted|decided_in — default distilled_from"
  }
}
```

#### `audit_thoughts`

```json
{
  "name": "audit_thoughts",
  "description": "List thoughts including hidden ones (admin use).",
  "inputSchema": {
    "project_id": "string",
    "include_hidden": "boolean — default false"
  }
}
```

#### `search_archive`

```json
{
  "name": "search_archive",
  "description": "Multi-modal search over archive artifacts using structured QuerySpec.",
  "inputSchema": {"query_spec": "object — see 03-query-spec.md"}
}
```

#### `get_artifact`

```json
{
  "name": "get_artifact",
  "description": "Fetch archive artifact with edges, derived thoughts, entity refs.",
  "inputSchema": {
    "hash": "string",
    "include": "array — subset of ['edges', 'derived_thoughts', 'entity_refs', 'extractor_runs'] — default all"
  }
}
```

#### `session_artifacts`

```json
{
  "name": "session_artifacts",
  "description": "Chronological list of all artifacts for a session.",
  "inputSchema": {
    "session_id": "string",
    "since": "number — optional unix ts",
    "limit": "number — default 100",
    "cursor": "string — optional pagination"
  }
}
```

#### `capture_url`

```json
{
  "name": "capture_url",
  "description": "Capture a URL as a reference (mode=ref) or full archived fetch (mode=full). Optionally attach a note as a thought.",
  "inputSchema": {
    "url": "string",
    "project_id": "string",
    "mode": "string — 'ref'|'full', default 'full'",
    "note": "string — optional user note becomes a thought",
    "tags": "array of strings — optional",
    "thought_type_hint": "string — if note provided"
  }
}
```

#### `brain_metrics`

```json
{
  "name": "brain_metrics",
  "description": "Fetch timeseries data for a metric key.",
  "inputSchema": {
    "metric_key": "string",
    "project_id": "string — optional if scope='org'",
    "from": "number — unix ts",
    "to": "number — unix ts",
    "resolution": "string — 'raw'|'1h'|'1d', default auto by range"
  }
}
```

#### `brain_events`

```json
{
  "name": "brain_events",
  "description": "Fetch audit/event rows across ingest, extractor, hook, session, query tables.",
  "inputSchema": {
    "event_table": "string — 'ingest'|'extractor'|'hook'|'session'|'query'",
    "from": "number", "to": "number",
    "filters": "object — table-specific"
  }
}
```

#### `brain_query_logs`

```json
{
  "name": "brain_query_logs",
  "description": "Fetch your own query history with full rank explanations (useful for an agent debugging its own retrieval).",
  "inputSchema": {
    "from": "number", "to": "number",
    "filters": "object"
  }
}
```

## Ingestion contract versioning

Every ingested artifact carries `schema_version: INTEGER`.

- **Additive changes** (new optional `kind_specific_meta` keys, new edge relations): no version bump required.
- **Breaking changes** (field rename, field removal, semantics change): bump `schema_version`, implement migration fn in `brain/ingest-migrations.ts`, old artifacts NOT mutated — migration writes a translated-metadata sidecar row in `artifact_meta_v<n>` table.

Ingest endpoint accepts any `schema_version` up to the current one. Missing → assumed v1.

## Hook → artifact-kind map (locked)

| Hook | Kind emitted | Extra edges created |
|---|---|---|
| `UserPromptSubmit` | `conversation/turn/user_message` | `turn_in_session` → session_start |
| Assistant message (stream) | `conversation/turn/assistant_message`, plus `conversation/turn/thought` per extended-thinking block | `turn_in_session`, `thought_preceded_turn` |
| `PreToolUse` | `conversation/tool_call` | `turn_invoked_tool` from parent assistant turn |
| `PostToolUse` (Read) | `code/file_snapshot` | `turn_read_file` |
| `PostToolUse` (Edit/Write) | `code/diff` + `code/file_snapshot` | `turn_wrote_diff`, `diff_applied_to_file` |
| `PostToolUse` (Bash) | `process/command_output` + optionally `process/command` | `turn_ran_command` |
| `PostToolUse` (image in result) | `media/image/*` | `turn_produced_image` |
| `PostToolUse` (WebFetch) | `document/web_fetch` | `turn_fetched_url` |
| `SubagentStop` | `agent/subagent_spawn` + result summary artifact | `turn_spawned_subagent` |
| `PreCompact` | `conversation/meta/compaction` | `compaction_in_session` |
| `Stop` | `conversation/meta/session_end` + triggers auto-capture skill | `session_ended` |

## Rate limiting

- Per-org: 100 ingest/sec sustained, burst 500. 429 with `Retry-After`.
- Per-session: no limit; hooks fire at CLI pace.
- Per-IP on public API (none currently, reserved for mobile network tier): 20/sec.

## Error shape

```json
{
  "error": {
    "code": "INVALID_KIND",
    "message": "kind 'foo/bar' has no known top-level branch",
    "details": {"accepted_branches": ["conversation", "code", ...]}
  }
}
```

Error codes: `INVALID_KIND`, `INVALID_PROJECT`, `MISSING_FIELD`, `SIZE_LIMIT`, `CROSS_ORG`, `HIDDEN_PROJECT`, `SCHEMA_VERSION`, `RATE_LIMIT`, `INGEST_FAILED`, `NOT_FOUND`.

## Header conventions

Ingest-related responses include:
- `X-Brain-Hash` — the resolved artifact hash
- `X-Brain-Duplicate` — `true|false`
- `X-Brain-Schema-Version` — server's current version
- `X-Brain-Latency-Ms` — server-side processing latency

Retrieval responses include:
- `X-Brain-Query-Id` — for later PATCH of used_ids
- `X-Brain-Confidence` — 0–1
- `X-Brain-Layer-Mix` — "archive=14,thoughts=6"
