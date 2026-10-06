# Phase 0 — Foundation

> Silent capture. Hooks fire, server ingests, SQLite stores. No search UI, no user-visible surface. If we get Phase 0 wrong, every later phase pays for it.

## Deliverables

1. Per-org brain storage directory created on server boot.
2. `active.db` per org with full Phase 0 schema (archive core + feature-table stubs + event skeletons + triggers).
3. `catalog.db` per org with project visibility, sealed-file registry stub, kind review queue.
4. `/api/brain/ingest` endpoint live, idempotent, auth'd.
5. Claude Code hooks installer extended to emit every hook type to `/api/brain/ingest`.
6. Append-only triggers active; cross-org edge rejection active.
7. Ingest pipeline: hash (SHA-256), dedup via PK conflict, skeleton row insert, synchronous edge insert, async extractor enqueue (stub queue — actual extractors land in later phases).
8. Watchdog: emit alert if an active session hasn't produced artifacts in ≥ 10 min.
9. Zero user-visible UI.

## Success criteria

- Launch a session via existing NoSleep API → see artifact rows appear in `data/brain/<org>/active.db` for every user message, assistant message, tool call, tool result, diff, file snapshot, command output.
- `SELECT COUNT(*) FROM artifacts WHERE session_id = ?` matches expectations for a 10-turn session (~50 artifacts).
- Attempting `DELETE FROM artifacts` returns the append-only abort error.
- Attempting to insert a cross-org edge returns the cross-org abort error.
- Replaying the same content twice returns `duplicate: true` on second ingest with no new row.
- Hooks callback latency p95 < 100 ms on local dev box.

## Files to create

```
packages/server/src/brain/
├── storage/
│   ├── paths.ts              # per-org dir resolution
│   ├── active-db.ts          # open / cache connections to active.db per org
│   ├── catalog-db.ts         # open / cache catalog.db per org
│   └── migrations.ts         # brain-specific migrations list + runner (mirrors existing pattern)
├── ingest/
│   ├── hash.ts               # SHA-256 helpers
│   ├── pipeline.ts           # main ingest fn (hash → dedup → insert → edges → enqueue)
│   ├── kind-validator.ts     # taxonomy branch validation + review-queue push
│   ├── extractor-queue.ts    # simple in-memory / SQLite-backed queue stub
│   └── types.ts              # IngestRequest, IngestResult, edge shapes
├── hooks/
│   ├── installer-patches.ts  # adds brain callback URLs to existing hooks-installer config
│   └── handlers.ts           # per-hook-type → kind mapping + artifact construction
├── routes/
│   ├── ingest.ts             # Fastify route: POST /api/brain/ingest
│   └── health.ts             # GET /api/admin/brain/health (stub)
├── watchdog/
│   └── session-silence.ts    # cron: flag sessions with no recent ingest events
├── config.ts                 # brain config constants (paths, compression, etc.)
└── index.ts                  # wiring entry point called from server.ts
```

## Files to modify

```
packages/server/src/server.ts                           # wire brain routes + storage init
packages/server/src/orchestrator/hooks-installer.ts     # add brain callback URLs to installed hooks
packages/server/src/routes/hooks-callback.ts            # forward hook payloads to brain ingest (non-blocking)
packages/server/src/db/migrations-list.ts               # no changes — brain DB is separate
packages/server/package.json                            # add deps: better-sqlite3 already present; add 'zstd-napi' for compression, 'ulid' for IDs
```

## Storage layout

```
<data_dir>/brain/
├── org_personal/
│   ├── active.db                           # current quarter, WAL mode
│   ├── active.db-wal
│   ├── active.db-shm
│   ├── catalog.db                          # mutable metadata
│   ├── sealed/
│   │   └── sealed-2026-Q1.db              # (created by seal job, Phase 8)
│   └── blobs/                              # optional CAS for large binaries >N MB (Phase 5)
├── org_work/
│   └── …
└── org_<slug>/      # one dir per user-defined org
    └── …
```

`<data_dir>` defaults to `data/` under NoSleep root, configurable via `NOSLEEP_DATA_DIR`.

## Schema (Phase 0 subset)

From `01-schema.sql`, Phase 0 creates ALL tables and triggers on first boot of each org's `active.db`:

**Populated in Phase 0:** `artifacts`, `artifact_projects`, `artifact_edges`, `artifacts_fts_src`, `ingest_events`, `hook_fires`, append-only triggers, cross-org rejection trigger.

**Created but empty in Phase 0 (populated later phases):** `image_features`, `code_symbols`, `artifact_num_meta`, `validity` R-tree + `artifact_validity`, `vec_text_map`, `vec_clip_map`, `vec_hnsw_blob`, `ppr_scores`, `thought_cooccur`, `thoughts`, `thoughts_fts`, `thought_refs`, `thought_archive_refs`, `entities`, `entity_refs`, `metrics`, `metrics_rollup_1h`, `metrics_rollup_1d`, `extractor_runs`, `query_logs`, `brain_session_events`.

FTS5 virtual table `artifacts_fts` is created in Phase 0 but not populated (Phase 1 wires the text-extraction step). `sqlite-vec` `vec_text` and `vec_clip` virtual tables are NOT created in Phase 0 — those come in Phase 3 when we load the extension.

`catalog.db` schema:

```sql
CREATE TABLE IF NOT EXISTS projects (
  project_id        TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  name              TEXT NOT NULL,
  visibility        TEXT NOT NULL DEFAULT 'active',    -- 'active'|'hidden'|'archived_noise'
  hidden_reason     TEXT,
  hidden_at         INTEGER,
  hidden_by         TEXT,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sealed_files (
  file_name         TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  quarter           TEXT NOT NULL,                      -- '2026-Q1'
  ts_from           INTEGER NOT NULL,
  ts_to             INTEGER NOT NULL,
  size_bytes        INTEGER,
  artifact_count    INTEGER,
  verify_hash       TEXT,
  verified_at       INTEGER,
  compression_ratio REAL
);

CREATE TABLE IF NOT EXISTS catalog_files (
  project_id        TEXT NOT NULL,
  file_name         TEXT NOT NULL,
  has_data          INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (project_id, file_name)
);

CREATE TABLE IF NOT EXISTS kind_review_queue (
  kind              TEXT PRIMARY KEY,
  first_seen_ts     INTEGER NOT NULL,
  sample_hash       TEXT,
  count             INTEGER NOT NULL DEFAULT 1,
  resolved          INTEGER NOT NULL DEFAULT 0,
  resolution        TEXT                                -- 'approved'|'renamed_to'|'rejected'
);

CREATE TABLE IF NOT EXISTS brain_config (
  key               TEXT PRIMARY KEY,
  value_json        TEXT NOT NULL,
  updated_at        INTEGER NOT NULL
);
```

## Ingest pipeline — exact algorithm

Input: `IngestRequest` (see `04-mcp-and-api.md` body shape).

```
function ingest(req: IngestRequest): IngestResult {
  const started = now()
  validateBranch(req.kind)                          // throws INVALID_KIND if top-level unknown
  validateProject(req.project_id, req.org_id)       // catalog.db check + org match

  const contentBuf = toBuffer(req.content, req.content_type)
  const hash = sha256hex(contentBuf)

  const db = activeDbFor(req.org_id)

  const existing = db.prepare('SELECT hash FROM artifacts WHERE hash = ?').get(hash)
  const duplicate = !!existing

  const tx = db.transaction(() => {
    if (!duplicate) {
      const compressed = zstdCompress(contentBuf)
      db.prepare(`INSERT INTO artifacts
        (hash, kind, ts, org_id, project_id, session_id, turn_ord,
         origin_tool, origin_version, actor, content, content_type,
         size, compression, schema_version, kind_specific_meta)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'zstd', ?, ?)`
      ).run(hash, req.kind, req.ts ?? now(), req.org_id, req.project_id,
            req.session_id, req.turn_ord,
            req.origin.tool, req.origin.version, req.origin.actor,
            compressed, req.content_type, contentBuf.length,
            req.schema_version, JSON.stringify(req.kind_specific_meta ?? {}))

      // FTS source (text-convertible kinds only)
      const text = tryExtractText(req.kind, contentBuf, req.content_type)
      if (text !== null) {
        db.prepare('INSERT INTO artifacts_fts_src (hash, project_id, kind, text, ts) VALUES (?,?,?,?,?)')
          .run(hash, req.project_id, req.kind, text, req.ts ?? now())
      }
    }

    // project binding (always, even on duplicate — same hash may surface in multiple projects)
    db.prepare('INSERT OR IGNORE INTO artifact_projects (hash, project_id, first_seen_ts) VALUES (?,?,?)')
      .run(hash, req.project_id, now())

    // edges (always appended; unique PK prevents duplicate relation writes)
    for (const e of req.edges ?? []) {
      db.prepare(`INSERT OR IGNORE INTO artifact_edges
        (from_hash, to_hash, relation, scope, origin, project_id, created_at)
        VALUES (?,?,?,?,?,?,?)`
      ).run(hash, e.to_hash, e.relation, e.scope ?? 'intra_project', 'ingest_auto',
            req.project_id, now())
    }

    // ingest_events (audit)
    db.prepare(`INSERT INTO ingest_events
      (event_id, ts, artifact_hash, source_tool, source_version, schema_version,
       duplicate, enqueued_json, session_id, project_id, org_id, duration_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(ulid(), now(), hash, req.origin.tool, req.origin.version,
          req.schema_version, duplicate ? 1 : 0,
          JSON.stringify(enqueueList(req.kind)),
          req.session_id, req.project_id, req.org_id,
          now() - started)
  })
  tx()

  if (!duplicate) enqueueExtractors(hash, req.kind)   // stub queue; Phase 1+ wires real workers

  return { hash, duplicate, enqueued: enqueueList(req.kind) }
}
```

### Text extraction (for FTS) — Phase 0 rules

- `conversation/turn/*`, `knowledge/*`, `decision/*`, `document/markdown`, `document/web_fetch` (after fetch; Phase 1+): use payload as-is if utf-8 text.
- `code/*`: payload as-is.
- `conversation/tool_call`: JSON stringify `tool_input`.
- `conversation/tool_result`: if `content_type` text — payload; if JSON — stringify.
- `process/command_output`: payload.
- `media/*`: NULL (Phase 5 extractors fill via OCR/caption).
- Unknown: NULL, but queue kind for review.

### Enqueue list — Phase 0 rules

Phase 0 only logs "would enqueue" names; extractors themselves land in Phase 1+. List contains extractor names per `02-taxonomy.md` embed allowlist and feature-table fill rules.

## Hook wiring

Extend `hooks-installer.ts` to install **two** callbacks per hook type: existing control callback + new brain callback.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "curl -s -X POST http://localhost:3777/api/hooks/user-prompt ...", "timeout": 10000 },
          { "type": "command", "command": "curl -s -X POST http://localhost:3777/api/brain/hook-ingest/user-prompt ...", "timeout": 10000 }
        ]
      }
    ],
    ...
  }
}
```

Brain ingest endpoint is distinct: `/api/brain/hook-ingest/:hook_type` — a thin adapter that translates hook payload → `IngestRequest` and forwards to `ingest()`. Keeps the public `/api/brain/ingest` contract clean while letting hook payloads be the less-clean input they are.

### `/api/brain/hook-ingest/:hook_type` adapter logic

For each hook type, construct the artifact(s):

```typescript
// pre-tool
POST /api/brain/hook-ingest/pre-tool
Body: { orgId, sessionId, toolName, toolInput }

Constructs:
- 1 × conversation/tool_call artifact (content = JSON.stringify({toolName, toolInput}))
- Edge: (this_hash) → (session_start_hash) relation 'tool_call_in_session'
- Edge: (last_assistant_turn_hash) → (this_hash) relation 'turn_invoked_tool'
  (we maintain a tiny in-memory per-session "latest_assistant_turn" cache to avoid a DB read)

// post-tool — dispatch per tool
toolName=Write → construct code/diff + code/file_snapshot
toolName=Edit → construct code/diff
toolName=Read → construct code/file_snapshot
toolName=Bash → construct process/command_output + optionally process/command
toolName=WebFetch → construct document/web_fetch (and enqueue link ingest for reference/link)
toolName=* → construct conversation/tool_result generically

// pre-compact
→ conversation/meta/compaction + link to session
// stop
→ conversation/meta/session_end + trigger auto-capture skill invocation (Phase 2)
// assistant message (via streaming, NOT a hook) → wired in Phase 1 via existing message stream
```

### Edge latency

Hook fires `curl ... --max-time 1.0` (1 second max). Our brain ingest MUST return in < 500 ms or the hook gives up. We return 202 quickly and do extractor work async.

## Watchdog

Cron runs every 2 min (Fastify schedule):

```sql
-- sessions that have been active >5 min without any ingest_event
SELECT s.id, s.org_id, s.project_id
FROM sessions s
LEFT JOIN (
  SELECT session_id, MAX(ts) AS last_ts FROM ingest_events
  WHERE ts > strftime('%s','now','-10 minutes') GROUP BY session_id
) ie ON ie.session_id = s.id
WHERE s.status = 'active'
  AND ie.last_ts IS NULL
  AND s.started_at < strftime('%s','now','-5 minutes')
```

Emit alert `brain_hook_silence` with session_id + project_id. Existing NoSleep alert system handles notification.

Also emit metric `hook.silence.count` (Phase 7 reads this).

## Unknowns / risks

1. **Hook latency at scale**: if a session produces 100 tool calls/min, brain ingest must keep up. Measured locally in tight loop: SQLite insert + zstd compress of 1KB payload ≈ 0.5 ms. Headroom fine to ~1000/sec.
2. **`kind_specific_meta` JSON size**: some tool_results are huge. Store full payload in `content` (zstd compressed), only small structured meta in `kind_specific_meta`. Hard cap: 32 KB on `kind_specific_meta`.
3. **Idempotency across server restarts**: hash-based dedup is stateless — works across restarts trivially.
4. **Cross-session edges** (e.g. session_B resumes session_A): same `artifact_edges` table, `scope='cross_project'` allowed within org. No special handling needed.
5. **Large binary artifacts** (images, videos): Phase 0 stores inline in `content` BLOB up to 1 MB. Larger: Phase 5 introduces `blobs/` CAS directory with hash → disk path mapping. For Phase 0, hook adapter truncates binaries >1 MB to the first 1 MB + flag `truncated=true` in `kind_specific_meta`.

## Test plan

- Unit: hash stability, dedup, edge insert idempotency, trigger-rejected DELETE/UPDATE, cross-org edge rejection.
- Integration: launch a scripted Claude Code session, verify row counts in `active.db` match hook fires in `session_events`.
- Load: 100 req/sec sustained for 60 sec via artillery/hey. Verify no data loss, latency p95 < 100 ms.
- Recovery: kill server mid-ingest, restart, verify no orphan rows (WAL replay should handle).

## Phase 0 does NOT include

- Any search (Phase 1)
- Any UI (Phase 1 web browser; Phase 2 mobile)
- Thoughts capture (Phase 2)
- Embeddings or vector tables populated (Phase 3)
- Entities (Phase 4)
- Image/code extractors (Phase 5)
- D3 graph (Phase 6)
- Observability dashboards (Phase 7)
- HNSW or per-file indexes (Phase 8)

## Estimated size

- New code: ~1,500 LOC TypeScript (ingest pipeline + hook adapter + storage + migrations + routes)
- Modified: ~200 LOC (hooks-installer + server.ts wiring)
- Tests: ~500 LOC
- Doc: this file + schema.sql already written

## First commit boundary

Suggested split:
1. **Commit A** — schema + storage + migrations + empty Phase 0 tables. `npm run dev` starts, brain directory created, no hooks firing yet.
2. **Commit B** — ingest pipeline + routes + tests.
3. **Commit C** — hook-installer patches + hook-ingest adapter + live capture verification.
4. **Commit D** — watchdog + cross-org safety tests + docs.
