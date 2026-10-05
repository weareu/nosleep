-- NoSleep Brain — canonical SQLite DDL
-- Applies to active.db and (frozen into) each sealed-YYYY-QN.db.
-- Organised by concern. Triggers at bottom. No DROP. No destructive statements.
--
-- Conventions:
--   hash:       content-addressed SHA-256 hex (64 chars)
--   ts:         unix seconds (INTEGER)
--   id:         ULID (TEXT) unless explicitly hash-addressed
--   *_json:     JSON text, parsed at read time
--   project_id: NEVER NULL. Use sentinel '_org_level' for org-wide items.
--   org_id:     NEVER NULL.
--
-- Append-only rule: no UPDATE, no DELETE on any of these archive tables.
-- Enforced by triggers at the bottom of this file.

-- =====================================================================
-- ARCHIVE CORE (Phase 0)
-- =====================================================================

CREATE TABLE IF NOT EXISTS artifacts (
  hash              TEXT PRIMARY KEY,           -- SHA-256 of content
  kind              TEXT NOT NULL,              -- path-typed, e.g. 'conversation/turn/assistant_message'
  ts                INTEGER NOT NULL,
  org_id            TEXT NOT NULL,
  project_id        TEXT NOT NULL,              -- '_org_level' sentinel allowed
  session_id        TEXT,
  turn_ord          INTEGER,                    -- ordinal within session, NULL for non-turn artifacts
  origin_tool       TEXT NOT NULL,              -- 'claude-code' | 'opencode' | 'mobile' | 'webhook' | ...
  origin_version    TEXT,
  actor             TEXT,                       -- agent id or user id
  content           BLOB,                       -- zstd-compressed payload (small inline); NULL if large external
  content_type      TEXT,                       -- mime
  size              INTEGER NOT NULL,           -- uncompressed bytes
  compression       TEXT,                       -- 'zstd' | 'zstd-dict-YYYYQN' | NULL
  schema_version    INTEGER NOT NULL DEFAULT 1,
  kind_specific_meta TEXT                       -- kind-specific JSON metadata
);

CREATE INDEX IF NOT EXISTS idx_artifacts_proj_ts     ON artifacts(project_id, ts);
CREATE INDEX IF NOT EXISTS idx_artifacts_proj_kind   ON artifacts(project_id, kind);
CREATE INDEX IF NOT EXISTS idx_artifacts_session_ord ON artifacts(session_id, turn_ord);
CREATE INDEX IF NOT EXISTS idx_artifacts_org_ts      ON artifacts(org_id, ts);
CREATE INDEX IF NOT EXISTS idx_artifacts_kind_ts     ON artifacts(kind, ts);
CREATE INDEX IF NOT EXISTS idx_artifacts_actor_ts    ON artifacts(actor, ts);

-- Many-to-many mapping: same hash can appear in multiple projects (shared files, quoted refs)
CREATE TABLE IF NOT EXISTS artifact_projects (
  hash              TEXT NOT NULL,
  project_id        TEXT NOT NULL,
  first_seen_ts     INTEGER NOT NULL,
  PRIMARY KEY (hash, project_id)
);
CREATE INDEX IF NOT EXISTS idx_artproj_project ON artifact_projects(project_id);

-- Archive ↔ archive edges (mechanical audit graph)
CREATE TABLE IF NOT EXISTS artifact_edges (
  from_hash         TEXT NOT NULL,
  to_hash           TEXT NOT NULL,
  relation          TEXT NOT NULL,
  scope             TEXT NOT NULL DEFAULT 'intra_project',   -- 'intra_project' | 'cross_project'
  origin            TEXT NOT NULL,                            -- 'ingest_auto' | 'user_linked' | 'llm_suggested'
  project_id        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (from_hash, to_hash, relation)
);
CREATE INDEX IF NOT EXISTS idx_edges_from_proj ON artifact_edges(from_hash, project_id);
CREATE INDEX IF NOT EXISTS idx_edges_to_proj   ON artifact_edges(to_hash, project_id);
CREATE INDEX IF NOT EXISTS idx_edges_rel_proj  ON artifact_edges(relation, project_id);

-- =====================================================================
-- ARCHIVE FTS (Phase 1)
-- =====================================================================

-- Virtual table backed by FTS5. Populated by trigger or explicit INSERT.
-- Separate `fts_content_view` mat view avoids tokenising blobs directly.
CREATE TABLE IF NOT EXISTS artifacts_fts_src (
  hash              TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  kind              TEXT NOT NULL,
  text              TEXT NOT NULL,               -- extracted text content
  ts                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fts_src_proj ON artifacts_fts_src(project_id);

CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
  hash UNINDEXED,
  project_id UNINDEXED,
  kind UNINDEXED,
  text,
  ts UNINDEXED,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

-- Keep fts in sync with fts_src (one direction; append-only)
CREATE TRIGGER IF NOT EXISTS trg_fts_src_ai
AFTER INSERT ON artifacts_fts_src
BEGIN
  INSERT INTO artifacts_fts(hash, project_id, kind, text, ts)
    VALUES (new.hash, new.project_id, new.kind, new.text, new.ts);
END;

-- =====================================================================
-- KIND-SPECIFIC FEATURE TABLES (Phase 5 writes; Phase 0 creates)
-- =====================================================================

CREATE TABLE IF NOT EXISTS image_features (
  hash              TEXT PRIMARY KEY,
  phash             INTEGER NOT NULL,           -- 64-bit perceptual hash
  width             INTEGER,
  height            INTEGER,
  format            TEXT,
  mime              TEXT,
  exif_json         TEXT,
  scene_class       TEXT,                        -- 'ui'|'photo'|'diagram'|'chart'|'terminal'
  ocr_text          TEXT,
  caption           TEXT,
  extracted_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_image_phash  ON image_features(phash);
CREATE INDEX IF NOT EXISTS idx_image_scene  ON image_features(scene_class);

CREATE TABLE IF NOT EXISTS code_symbols (
  hash              TEXT NOT NULL,
  file_path         TEXT,
  symbol            TEXT NOT NULL,
  symbol_kind       TEXT,                        -- 'function'|'class'|'import'|'type'|'variable'
  line_start        INTEGER,
  line_end          INTEGER,
  language          TEXT
);
CREATE INDEX IF NOT EXISTS idx_codesym_sym  ON code_symbols(symbol);
CREATE INDEX IF NOT EXISTS idx_codesym_file ON code_symbols(file_path, hash);
CREATE INDEX IF NOT EXISTS idx_codesym_hash ON code_symbols(hash);

CREATE TABLE IF NOT EXISTS artifact_num_meta (
  hash              TEXT NOT NULL,
  key               TEXT NOT NULL,               -- 'exit_code'|'duration_ms'|'token_count'|'size_bytes'|...
  value             REAL NOT NULL,
  PRIMARY KEY (hash, key)
);
CREATE INDEX IF NOT EXISTS idx_num_meta_key_val ON artifact_num_meta(key, value);

-- Temporal intervals (validity windows for facts/decisions)
CREATE VIRTUAL TABLE IF NOT EXISTS validity USING rtree(
  id,                                             -- matches artifacts.hash via artifact_validity map below
  valid_from,
  valid_to
);
CREATE TABLE IF NOT EXISTS artifact_validity (
  hash              TEXT PRIMARY KEY,
  rtree_id          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artval_rtree ON artifact_validity(rtree_id);

-- =====================================================================
-- VECTOR INDEXES (Phase 3+ populates; sqlite-vec virtual tables)
-- =====================================================================

-- These are created at runtime after sqlite-vec extension loads; declared here
-- for documentation. See Phase 0 spec for actual init sequence.
--   CREATE VIRTUAL TABLE vec_text USING vec0(embedding float[1024]);
--   CREATE VIRTUAL TABLE vec_clip USING vec0(embedding float[512]);
-- Row IDs in vec_text / vec_clip map to a sidecar table:
CREATE TABLE IF NOT EXISTS vec_text_map (
  rowid             INTEGER PRIMARY KEY AUTOINCREMENT,
  hash              TEXT NOT NULL,               -- points at artifact or thought
  referrer_kind     TEXT NOT NULL,               -- 'artifact' | 'thought'
  chunk_ord         INTEGER NOT NULL DEFAULT 0,  -- for chunked embedding
  chunk_text        TEXT,
  embedded_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vec_text_map_hash ON vec_text_map(hash, referrer_kind);

CREATE TABLE IF NOT EXISTS vec_clip_map (
  rowid             INTEGER PRIMARY KEY AUTOINCREMENT,
  hash              TEXT NOT NULL,               -- media/image/* only
  embedded_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vec_clip_map_hash ON vec_clip_map(hash);

-- Per-sealed-file HNSW index (Phase 8) — stored as BLOB in a 1-row table per sealed file
CREATE TABLE IF NOT EXISTS vec_hnsw_blob (
  index_name        TEXT PRIMARY KEY,            -- 'vec_text' | 'vec_clip'
  dim               INTEGER NOT NULL,
  size              INTEGER NOT NULL,            -- vectors indexed
  blob              BLOB NOT NULL,               -- serialised usearch/hnswlib index
  built_at          INTEGER NOT NULL
);

-- =====================================================================
-- GRAPH CACHES (Phase 4+)
-- =====================================================================

CREATE TABLE IF NOT EXISTS ppr_scores (
  seed_hash         TEXT NOT NULL,
  target_hash       TEXT NOT NULL,
  score             REAL NOT NULL,
  computed_at       INTEGER NOT NULL,
  PRIMARY KEY (seed_hash, target_hash)
);
CREATE INDEX IF NOT EXISTS idx_ppr_target ON ppr_scores(target_hash);

-- Thought co-occurrence derived edges (Phase 6 cache for D3)
CREATE TABLE IF NOT EXISTS thought_cooccur (
  a_id              TEXT NOT NULL,
  b_id              TEXT NOT NULL,
  relation          TEXT NOT NULL,               -- 'shared_topic'|'shared_people'|'same_session'|'temporal_near'|'source_linked'
  weight            REAL NOT NULL,
  computed_at       INTEGER NOT NULL,
  PRIMARY KEY (a_id, b_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_cooccur_a ON thought_cooccur(a_id);
CREATE INDEX IF NOT EXISTS idx_cooccur_b ON thought_cooccur(b_id);

-- =====================================================================
-- THOUGHTS LAYER (Phase 2)
-- =====================================================================

CREATE TABLE IF NOT EXISTS thoughts (
  id                TEXT PRIMARY KEY,            -- ULID
  org_id            TEXT NOT NULL,
  project_id        TEXT NOT NULL,               -- '_org_level' sentinel allowed
  content           TEXT NOT NULL,
  metadata_json     TEXT NOT NULL,               -- {type, topics[], people[], action_items[], dates_mentioned[]}
  thought_type      TEXT,                         -- denormalised from metadata_json for fast filtering
  source_kind       TEXT NOT NULL,               -- 'mcp_capture'|'auto_capture_skill'|'mobile_note'|'promoted_from_archive'|'web_ui'|'url_capture'
  source_refs_json  TEXT,                         -- [{hash, relation}]
  strategy_node_ref TEXT,                         -- optional FK to strategy_nodes.id (forward-plan bridge)
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  visibility        TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_thoughts_proj_created ON thoughts(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_thoughts_type         ON thoughts(project_id, thought_type);
CREATE INDEX IF NOT EXISTS idx_thoughts_vis          ON thoughts(project_id, visibility);
CREATE INDEX IF NOT EXISTS idx_thoughts_strategy     ON thoughts(strategy_node_ref);

-- FTS over thoughts (content + flattened metadata arrays)
CREATE VIRTUAL TABLE IF NOT EXISTS thoughts_fts USING fts5(
  id UNINDEXED,
  project_id UNINDEXED,
  thought_type UNINDEXED,
  content,
  topics_flat,
  people_flat,
  actions_flat,
  created_at UNINDEXED,
  tokenize = 'porter unicode61 remove_diacritics 2'
);

-- =====================================================================
-- CROSS-REFERENCE (Phase 4)
-- =====================================================================

CREATE TABLE IF NOT EXISTS thought_refs (
  from_thought_id   TEXT NOT NULL,
  to_thought_id     TEXT NOT NULL,
  relation          TEXT NOT NULL,
    -- 'refines'|'supersedes'|'contradicts'|'continues'|'related_to'|'duplicate_of'|'answers'|'asks_about'|'derives_from_thought'
  scope             TEXT NOT NULL DEFAULT 'intra_project',
  origin            TEXT NOT NULL,                -- 'user_linked'|'derived_cooccurrence'|'llm_suggested'|'skill_generated'
  project_id        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (from_thought_id, to_thought_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_trefs_from ON thought_refs(from_thought_id);
CREATE INDEX IF NOT EXISTS idx_trefs_to   ON thought_refs(to_thought_id);

CREATE TABLE IF NOT EXISTS thought_archive_refs (
  thought_id        TEXT NOT NULL,
  archive_hash      TEXT NOT NULL,
  relation          TEXT NOT NULL,
    -- 'distilled_from'|'quoted'|'summarizes'|'action_item_from'|'decided_in'|'references'|'refutes'|'triggered_by'
  project_id        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (thought_id, archive_hash, relation)
);
CREATE INDEX IF NOT EXISTS idx_tar_archive ON thought_archive_refs(archive_hash);
CREATE INDEX IF NOT EXISTS idx_tar_thought ON thought_archive_refs(thought_id);

-- =====================================================================
-- ENTITIES (Phase 4)
-- =====================================================================

CREATE TABLE IF NOT EXISTS entities (
  id                TEXT PRIMARY KEY,             -- ULID
  org_id            TEXT NOT NULL,
  kind              TEXT NOT NULL,                -- 'person'|'topic'|'concept'|'external_project'|'tool'|'agent'|'place'
  canonical_name    TEXT NOT NULL,
  aliases_json      TEXT,                          -- JSON string[]
  metadata_json     TEXT,
  merged_into       TEXT,                          -- lazy merge: if set, resolve to that entity id
  created_at        INTEGER NOT NULL,
  visibility        TEXT NOT NULL DEFAULT 'active'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_canon ON entities(org_id, kind, canonical_name);
CREATE INDEX IF NOT EXISTS idx_entities_merged ON entities(merged_into);

CREATE TABLE IF NOT EXISTS entity_refs (
  entity_id         TEXT NOT NULL,
  referrer_kind     TEXT NOT NULL,                 -- 'thought'|'artifact'
  referrer_id       TEXT NOT NULL,                 -- thought_id or archive_hash
  project_id        TEXT NOT NULL,
  relation          TEXT NOT NULL DEFAULT 'mentions',
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (entity_id, referrer_kind, referrer_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_entref_entity  ON entity_refs(entity_id);
CREATE INDEX IF NOT EXISTS idx_entref_ref     ON entity_refs(referrer_kind, referrer_id);
CREATE INDEX IF NOT EXISTS idx_entref_proj    ON entity_refs(project_id, entity_id);

-- =====================================================================
-- TIMESERIES (Phase 7)
-- =====================================================================

CREATE TABLE IF NOT EXISTS metrics (
  metric_key        TEXT NOT NULL,
  ts                INTEGER NOT NULL,
  value             REAL NOT NULL,
  tags_json         TEXT,
  project_id        TEXT NOT NULL,
  org_id            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_key_ts       ON metrics(metric_key, ts);
CREATE INDEX IF NOT EXISTS idx_metrics_proj_key_ts  ON metrics(project_id, metric_key, ts);

CREATE TABLE IF NOT EXISTS metrics_rollup_1h (
  metric_key        TEXT NOT NULL,
  ts_hour           INTEGER NOT NULL,
  project_id        TEXT NOT NULL,
  org_id            TEXT NOT NULL,
  sum               REAL,
  count             INTEGER,
  avg               REAL,
  p50               REAL,
  p95               REAL,
  p99               REAL,
  min               REAL,
  max               REAL,
  PRIMARY KEY (metric_key, project_id, ts_hour)
);

CREATE TABLE IF NOT EXISTS metrics_rollup_1d (
  metric_key        TEXT NOT NULL,
  ts_day            INTEGER NOT NULL,
  project_id        TEXT NOT NULL,
  org_id            TEXT NOT NULL,
  sum               REAL,
  count             INTEGER,
  avg               REAL,
  p50               REAL,
  p95               REAL,
  p99               REAL,
  min               REAL,
  max               REAL,
  PRIMARY KEY (metric_key, project_id, ts_day)
);

-- =====================================================================
-- EVENT / AUDIT (Phase 7; query_logs skeleton from Phase 2)
-- =====================================================================

CREATE TABLE IF NOT EXISTS ingest_events (
  event_id          TEXT PRIMARY KEY,
  ts                INTEGER NOT NULL,
  artifact_hash     TEXT NOT NULL,
  source_tool       TEXT NOT NULL,
  source_version    TEXT,
  schema_version    INTEGER NOT NULL,
  duplicate         INTEGER NOT NULL,              -- 0|1
  enqueued_json     TEXT,
  session_id        TEXT,
  project_id        TEXT NOT NULL,
  org_id            TEXT NOT NULL,
  duration_ms       REAL
);
CREATE INDEX IF NOT EXISTS idx_ingest_ts      ON ingest_events(ts);
CREATE INDEX IF NOT EXISTS idx_ingest_hash    ON ingest_events(artifact_hash);
CREATE INDEX IF NOT EXISTS idx_ingest_session ON ingest_events(session_id);

CREATE TABLE IF NOT EXISTS extractor_runs (
  run_id            TEXT PRIMARY KEY,
  ts                INTEGER NOT NULL,
  extractor         TEXT NOT NULL,
  extractor_version TEXT,
  prompt_version    TEXT,
  model             TEXT,
  artifact_hash     TEXT NOT NULL,
  duration_ms       REAL,
  result            TEXT NOT NULL,                 -- 'success'|'failed'|'skipped'
  error             TEXT,
  cost_usd          REAL,
  output_hash       TEXT,
  project_id        TEXT NOT NULL,
  org_id            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exrun_ts        ON extractor_runs(ts);
CREATE INDEX IF NOT EXISTS idx_exrun_artifact  ON extractor_runs(artifact_hash);
CREATE INDEX IF NOT EXISTS idx_exrun_extractor ON extractor_runs(extractor, ts);

CREATE TABLE IF NOT EXISTS hook_fires (
  fire_id           TEXT PRIMARY KEY,
  ts                INTEGER NOT NULL,
  hook_type         TEXT NOT NULL,
  session_id        TEXT,
  duration_ms       REAL,
  success           INTEGER NOT NULL,
  error             TEXT,
  payload_size      INTEGER,
  project_id        TEXT NOT NULL,
  org_id            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hookf_ts       ON hook_fires(ts);
CREATE INDEX IF NOT EXISTS idx_hookf_session  ON hook_fires(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_hookf_type_ts  ON hook_fires(hook_type, ts);

CREATE TABLE IF NOT EXISTS query_logs (
  query_id          TEXT PRIMARY KEY,
  ts                INTEGER NOT NULL,
  query_spec_json   TEXT NOT NULL,
  intent            TEXT,
  retrievers_json   TEXT,
  fused_top_json    TEXT,
  reranked_top_json TEXT,
  chosen_ids_json   TEXT,
  used_ids_json     TEXT,
  latency_ms        REAL,
  confidence_score  REAL,
  project_id        TEXT NOT NULL,
  org_id            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_qlogs_ts   ON query_logs(ts);
CREATE INDEX IF NOT EXISTS idx_qlogs_proj ON query_logs(project_id, ts);

-- Brain-specific session_events (distinct from orchestrator.session_events in main NoSleep DB)
CREATE TABLE IF NOT EXISTS brain_session_events (
  event_id          TEXT PRIMARY KEY,
  ts                INTEGER NOT NULL,
  session_id        TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  payload_json      TEXT,
  project_id        TEXT NOT NULL,
  org_id            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bse_ts      ON brain_session_events(ts);
CREATE INDEX IF NOT EXISTS idx_bse_session ON brain_session_events(session_id, ts);

-- =====================================================================
-- APPEND-ONLY ENFORCEMENT (triggers at bottom so tables exist first)
-- =====================================================================
-- Rule: no DELETE, no UPDATE on any of these tables. Triggers RAISE(ABORT).
-- Mutable state lives in catalog.db (project.visibility, sealed file metadata)
-- and existing NoSleep operational tables (strategy_nodes, sessions) — NOT here.

CREATE TRIGGER IF NOT EXISTS trg_no_delete_artifacts BEFORE DELETE ON artifacts
  BEGIN SELECT RAISE(ABORT, 'archive is append-only: artifacts'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_update_artifacts BEFORE UPDATE ON artifacts
  BEGIN SELECT RAISE(ABORT, 'archive is append-only: artifacts'); END;

CREATE TRIGGER IF NOT EXISTS trg_no_delete_artproj BEFORE DELETE ON artifact_projects
  BEGIN SELECT RAISE(ABORT, 'archive is append-only: artifact_projects'); END;

CREATE TRIGGER IF NOT EXISTS trg_no_delete_edges BEFORE DELETE ON artifact_edges
  BEGIN SELECT RAISE(ABORT, 'archive is append-only: artifact_edges'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_update_edges BEFORE UPDATE ON artifact_edges
  BEGIN SELECT RAISE(ABORT, 'archive is append-only: artifact_edges'); END;

CREATE TRIGGER IF NOT EXISTS trg_no_delete_fts_src BEFORE DELETE ON artifacts_fts_src
  BEGIN SELECT RAISE(ABORT, 'archive is append-only: artifacts_fts_src'); END;

CREATE TRIGGER IF NOT EXISTS trg_no_delete_image BEFORE DELETE ON image_features
  BEGIN SELECT RAISE(ABORT, 'archive is append-only: image_features'); END;

CREATE TRIGGER IF NOT EXISTS trg_no_delete_codesym BEFORE DELETE ON code_symbols
  BEGIN SELECT RAISE(ABORT, 'archive is append-only: code_symbols'); END;

CREATE TRIGGER IF NOT EXISTS trg_no_delete_num_meta BEFORE DELETE ON artifact_num_meta
  BEGIN SELECT RAISE(ABORT, 'archive is append-only: artifact_num_meta'); END;

CREATE TRIGGER IF NOT EXISTS trg_no_delete_trefs BEFORE DELETE ON thought_refs
  BEGIN SELECT RAISE(ABORT, 'archive is append-only: thought_refs'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_update_trefs BEFORE UPDATE ON thought_refs
  BEGIN SELECT RAISE(ABORT, 'archive is append-only: thought_refs'); END;

CREATE TRIGGER IF NOT EXISTS trg_no_delete_tar BEFORE DELETE ON thought_archive_refs
  BEGIN SELECT RAISE(ABORT, 'archive is append-only: thought_archive_refs'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_update_tar BEFORE UPDATE ON thought_archive_refs
  BEGIN SELECT RAISE(ABORT, 'archive is append-only: thought_archive_refs'); END;

CREATE TRIGGER IF NOT EXISTS trg_no_delete_entref BEFORE DELETE ON entity_refs
  BEGIN SELECT RAISE(ABORT, 'archive is append-only: entity_refs'); END;

CREATE TRIGGER IF NOT EXISTS trg_no_delete_metrics BEFORE DELETE ON metrics
  BEGIN SELECT RAISE(ABORT, 'archive is append-only: metrics'); END;
CREATE TRIGGER IF NOT EXISTS trg_no_update_metrics BEFORE UPDATE ON metrics
  BEGIN SELECT RAISE(ABORT, 'archive is append-only: metrics'); END;

CREATE TRIGGER IF NOT EXISTS trg_no_delete_ingest BEFORE DELETE ON ingest_events
  BEGIN SELECT RAISE(ABORT, 'archive is append-only: ingest_events'); END;

CREATE TRIGGER IF NOT EXISTS trg_no_delete_exrun BEFORE DELETE ON extractor_runs
  BEGIN SELECT RAISE(ABORT, 'archive is append-only: extractor_runs'); END;

CREATE TRIGGER IF NOT EXISTS trg_no_delete_hookf BEFORE DELETE ON hook_fires
  BEGIN SELECT RAISE(ABORT, 'archive is append-only: hook_fires'); END;

CREATE TRIGGER IF NOT EXISTS trg_no_delete_qlogs BEFORE DELETE ON query_logs
  BEGIN SELECT RAISE(ABORT, 'archive is append-only: query_logs'); END;

CREATE TRIGGER IF NOT EXISTS trg_no_delete_bse BEFORE DELETE ON brain_session_events
  BEGIN SELECT RAISE(ABORT, 'archive is append-only: brain_session_events'); END;

-- Cross-org edge rejection (safety belt in addition to app-level checks)
CREATE TRIGGER IF NOT EXISTS trg_edges_no_cross_org BEFORE INSERT ON artifact_edges
WHEN EXISTS (
  SELECT 1 FROM artifacts a1, artifacts a2
   WHERE a1.hash = new.from_hash AND a2.hash = new.to_hash
     AND a1.org_id <> a2.org_id
)
BEGIN SELECT RAISE(ABORT, 'cross-org artifact edges forbidden'); END;

-- Thoughts are mutable (updated_at, visibility, strategy_node_ref) — but we block
-- content/metadata_json rewrites to preserve extraction provenance. Callers that
-- want to re-extract create a new thought with a supersedes edge.
CREATE TRIGGER IF NOT EXISTS trg_thoughts_content_immutable BEFORE UPDATE OF content, metadata_json, source_kind, source_refs_json ON thoughts
  BEGIN SELECT RAISE(ABORT, 'thought content/metadata is immutable; capture a new thought and link supersedes'); END;

CREATE TRIGGER IF NOT EXISTS trg_no_delete_thoughts BEFORE DELETE ON thoughts
  BEGIN SELECT RAISE(ABORT, 'thoughts are append-only; set visibility instead'); END;

-- Entities are mutable (aliases can grow, merged_into can be set). No delete.
CREATE TRIGGER IF NOT EXISTS trg_no_delete_entities BEFORE DELETE ON entities
  BEGIN SELECT RAISE(ABORT, 'entities are append-only; set visibility or merged_into instead'); END;
