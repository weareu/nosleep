/**
 * Active.db schema — Phase 0. Creates every brain table the spec calls for.
 * Most are empty in Phase 0; later phases populate them.
 * See docs/plans/brain/01-schema.sql for the canonical DDL reference.
 */

import type { BrainMigration } from "./migrations.js";

type ExecDb = { exec(sql: string): unknown };

const m001CoreArchive: BrainMigration = {
  id: 1,
  name: "001_core_archive",
  up(db) {
    (db as unknown as ExecDb).exec(`
      CREATE TABLE IF NOT EXISTS artifacts (
        hash              TEXT PRIMARY KEY,
        kind              TEXT NOT NULL,
        ts                INTEGER NOT NULL,
        org_id            TEXT NOT NULL,
        project_id        TEXT NOT NULL,
        session_id        TEXT,
        turn_ord          INTEGER,
        origin_tool       TEXT NOT NULL,
        origin_version    TEXT,
        actor             TEXT,
        content           BLOB,
        content_type      TEXT,
        size              INTEGER NOT NULL,
        compression       TEXT,
        schema_version    INTEGER NOT NULL DEFAULT 1,
        kind_specific_meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_proj_ts     ON artifacts(project_id, ts);
      CREATE INDEX IF NOT EXISTS idx_artifacts_proj_kind   ON artifacts(project_id, kind);
      CREATE INDEX IF NOT EXISTS idx_artifacts_session_ord ON artifacts(session_id, turn_ord);
      CREATE INDEX IF NOT EXISTS idx_artifacts_org_ts      ON artifacts(org_id, ts);
      CREATE INDEX IF NOT EXISTS idx_artifacts_kind_ts     ON artifacts(kind, ts);
      CREATE INDEX IF NOT EXISTS idx_artifacts_actor_ts    ON artifacts(actor, ts);

      CREATE TABLE IF NOT EXISTS artifact_projects (
        hash              TEXT NOT NULL,
        project_id        TEXT NOT NULL,
        first_seen_ts     INTEGER NOT NULL,
        PRIMARY KEY (hash, project_id)
      );
      CREATE INDEX IF NOT EXISTS idx_artproj_project ON artifact_projects(project_id);

      CREATE TABLE IF NOT EXISTS artifact_edges (
        from_hash         TEXT NOT NULL,
        to_hash           TEXT NOT NULL,
        relation          TEXT NOT NULL,
        scope             TEXT NOT NULL DEFAULT 'intra_project',
        origin            TEXT NOT NULL,
        project_id        TEXT NOT NULL,
        created_at        INTEGER NOT NULL,
        PRIMARY KEY (from_hash, to_hash, relation)
      );
      CREATE INDEX IF NOT EXISTS idx_edges_from_proj ON artifact_edges(from_hash, project_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to_proj   ON artifact_edges(to_hash, project_id);
      CREATE INDEX IF NOT EXISTS idx_edges_rel_proj  ON artifact_edges(relation, project_id);
    `);
  },
};

const m002Fts: BrainMigration = {
  id: 2,
  name: "002_fts",
  up(db) {
    (db as unknown as ExecDb).exec(`
      CREATE TABLE IF NOT EXISTS artifacts_fts_src (
        hash              TEXT PRIMARY KEY,
        project_id        TEXT NOT NULL,
        kind              TEXT NOT NULL,
        text              TEXT NOT NULL,
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

      CREATE TRIGGER IF NOT EXISTS trg_fts_src_ai
      AFTER INSERT ON artifacts_fts_src
      BEGIN
        INSERT INTO artifacts_fts(hash, project_id, kind, text, ts)
          VALUES (new.hash, new.project_id, new.kind, new.text, new.ts);
      END;
    `);
  },
};

const m003FeatureStubs: BrainMigration = {
  id: 3,
  name: "003_feature_stubs",
  up(db) {
    (db as unknown as ExecDb).exec(`
      CREATE TABLE IF NOT EXISTS image_features (
        hash TEXT PRIMARY KEY, phash INTEGER NOT NULL, width INTEGER, height INTEGER,
        format TEXT, mime TEXT, exif_json TEXT, scene_class TEXT, ocr_text TEXT,
        caption TEXT, extracted_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_image_phash  ON image_features(phash);
      CREATE INDEX IF NOT EXISTS idx_image_scene  ON image_features(scene_class);

      CREATE TABLE IF NOT EXISTS code_symbols (
        hash TEXT NOT NULL, file_path TEXT, symbol TEXT NOT NULL, symbol_kind TEXT,
        line_start INTEGER, line_end INTEGER, language TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_codesym_sym  ON code_symbols(symbol);
      CREATE INDEX IF NOT EXISTS idx_codesym_file ON code_symbols(file_path, hash);
      CREATE INDEX IF NOT EXISTS idx_codesym_hash ON code_symbols(hash);

      CREATE TABLE IF NOT EXISTS artifact_num_meta (
        hash TEXT NOT NULL, key TEXT NOT NULL, value REAL NOT NULL,
        PRIMARY KEY (hash, key)
      );
      CREATE INDEX IF NOT EXISTS idx_num_meta_key_val ON artifact_num_meta(key, value);

      CREATE VIRTUAL TABLE IF NOT EXISTS validity USING rtree(id, valid_from, valid_to);
      CREATE TABLE IF NOT EXISTS artifact_validity (hash TEXT PRIMARY KEY, rtree_id INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_artval_rtree ON artifact_validity(rtree_id);

      CREATE TABLE IF NOT EXISTS vec_text_map (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL,
        referrer_kind TEXT NOT NULL, chunk_ord INTEGER NOT NULL DEFAULT 0,
        chunk_text TEXT, embedded_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vec_text_map_hash ON vec_text_map(hash, referrer_kind);

      CREATE TABLE IF NOT EXISTS vec_clip_map (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, embedded_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vec_clip_map_hash ON vec_clip_map(hash);

      CREATE TABLE IF NOT EXISTS vec_hnsw_blob (
        index_name TEXT PRIMARY KEY, dim INTEGER NOT NULL, size INTEGER NOT NULL,
        blob BLOB NOT NULL, built_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ppr_scores (
        seed_hash TEXT NOT NULL, target_hash TEXT NOT NULL, score REAL NOT NULL,
        computed_at INTEGER NOT NULL, PRIMARY KEY (seed_hash, target_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_ppr_target ON ppr_scores(target_hash);

      CREATE TABLE IF NOT EXISTS thought_cooccur (
        a_id TEXT NOT NULL, b_id TEXT NOT NULL, relation TEXT NOT NULL,
        weight REAL NOT NULL, computed_at INTEGER NOT NULL,
        PRIMARY KEY (a_id, b_id, relation)
      );
      CREATE INDEX IF NOT EXISTS idx_cooccur_a ON thought_cooccur(a_id);
      CREATE INDEX IF NOT EXISTS idx_cooccur_b ON thought_cooccur(b_id);
    `);
  },
};

const m004Thoughts: BrainMigration = {
  id: 4,
  name: "004_thoughts",
  up(db) {
    (db as unknown as ExecDb).exec(`
      CREATE TABLE IF NOT EXISTS thoughts (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL, project_id TEXT NOT NULL,
        content TEXT NOT NULL, metadata_json TEXT NOT NULL, thought_type TEXT,
        source_kind TEXT NOT NULL, source_refs_json TEXT, strategy_node_ref TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'active'
      );
      CREATE INDEX IF NOT EXISTS idx_thoughts_proj_created ON thoughts(project_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_thoughts_type         ON thoughts(project_id, thought_type);
      CREATE INDEX IF NOT EXISTS idx_thoughts_vis          ON thoughts(project_id, visibility);
      CREATE INDEX IF NOT EXISTS idx_thoughts_strategy     ON thoughts(strategy_node_ref);

      CREATE VIRTUAL TABLE IF NOT EXISTS thoughts_fts USING fts5(
        id UNINDEXED, project_id UNINDEXED, thought_type UNINDEXED,
        content, topics_flat, people_flat, actions_flat, created_at UNINDEXED,
        tokenize = 'porter unicode61 remove_diacritics 2'
      );

      CREATE TABLE IF NOT EXISTS thought_refs (
        from_thought_id TEXT NOT NULL, to_thought_id TEXT NOT NULL,
        relation TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'intra_project',
        origin TEXT NOT NULL, project_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (from_thought_id, to_thought_id, relation)
      );
      CREATE INDEX IF NOT EXISTS idx_trefs_from ON thought_refs(from_thought_id);
      CREATE INDEX IF NOT EXISTS idx_trefs_to   ON thought_refs(to_thought_id);

      CREATE TABLE IF NOT EXISTS thought_archive_refs (
        thought_id TEXT NOT NULL, archive_hash TEXT NOT NULL,
        relation TEXT NOT NULL, project_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (thought_id, archive_hash, relation)
      );
      CREATE INDEX IF NOT EXISTS idx_tar_archive ON thought_archive_refs(archive_hash);
      CREATE INDEX IF NOT EXISTS idx_tar_thought ON thought_archive_refs(thought_id);
    `);
  },
};

const m005Entities: BrainMigration = {
  id: 5,
  name: "005_entities",
  up(db) {
    (db as unknown as ExecDb).exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL, kind TEXT NOT NULL,
        canonical_name TEXT NOT NULL, aliases_json TEXT, metadata_json TEXT,
        merged_into TEXT, created_at INTEGER NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'active'
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_canon ON entities(org_id, kind, canonical_name);
      CREATE INDEX IF NOT EXISTS idx_entities_merged ON entities(merged_into);

      CREATE TABLE IF NOT EXISTS entity_refs (
        entity_id TEXT NOT NULL, referrer_kind TEXT NOT NULL, referrer_id TEXT NOT NULL,
        project_id TEXT NOT NULL, relation TEXT NOT NULL DEFAULT 'mentions',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (entity_id, referrer_kind, referrer_id, relation)
      );
      CREATE INDEX IF NOT EXISTS idx_entref_entity  ON entity_refs(entity_id);
      CREATE INDEX IF NOT EXISTS idx_entref_ref     ON entity_refs(referrer_kind, referrer_id);
      CREATE INDEX IF NOT EXISTS idx_entref_proj    ON entity_refs(project_id, entity_id);
    `);
  },
};

const m006TimeseriesEvents: BrainMigration = {
  id: 6,
  name: "006_timeseries_events",
  up(db) {
    (db as unknown as ExecDb).exec(`
      CREATE TABLE IF NOT EXISTS metrics (
        metric_key TEXT NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL,
        tags_json TEXT, project_id TEXT NOT NULL, org_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_metrics_key_ts       ON metrics(metric_key, ts);
      CREATE INDEX IF NOT EXISTS idx_metrics_proj_key_ts  ON metrics(project_id, metric_key, ts);

      CREATE TABLE IF NOT EXISTS metrics_rollup_1h (
        metric_key TEXT NOT NULL, ts_hour INTEGER NOT NULL,
        project_id TEXT NOT NULL, org_id TEXT NOT NULL,
        sum REAL, count INTEGER, avg REAL, p50 REAL, p95 REAL, p99 REAL, min REAL, max REAL,
        PRIMARY KEY (metric_key, project_id, ts_hour)
      );
      CREATE TABLE IF NOT EXISTS metrics_rollup_1d (
        metric_key TEXT NOT NULL, ts_day INTEGER NOT NULL,
        project_id TEXT NOT NULL, org_id TEXT NOT NULL,
        sum REAL, count INTEGER, avg REAL, p50 REAL, p95 REAL, p99 REAL, min REAL, max REAL,
        PRIMARY KEY (metric_key, project_id, ts_day)
      );

      CREATE TABLE IF NOT EXISTS ingest_events (
        event_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, artifact_hash TEXT NOT NULL,
        source_tool TEXT NOT NULL, source_version TEXT, schema_version INTEGER NOT NULL,
        duplicate INTEGER NOT NULL, enqueued_json TEXT, session_id TEXT,
        project_id TEXT NOT NULL, org_id TEXT NOT NULL, duration_ms REAL
      );
      CREATE INDEX IF NOT EXISTS idx_ingest_ts      ON ingest_events(ts);
      CREATE INDEX IF NOT EXISTS idx_ingest_hash    ON ingest_events(artifact_hash);
      CREATE INDEX IF NOT EXISTS idx_ingest_session ON ingest_events(session_id);

      CREATE TABLE IF NOT EXISTS extractor_runs (
        run_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, extractor TEXT NOT NULL,
        extractor_version TEXT, prompt_version TEXT, model TEXT,
        artifact_hash TEXT NOT NULL, duration_ms REAL, result TEXT NOT NULL,
        error TEXT, cost_usd REAL, output_hash TEXT,
        project_id TEXT NOT NULL, org_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_exrun_ts        ON extractor_runs(ts);
      CREATE INDEX IF NOT EXISTS idx_exrun_artifact  ON extractor_runs(artifact_hash);
      CREATE INDEX IF NOT EXISTS idx_exrun_extractor ON extractor_runs(extractor, ts);

      CREATE TABLE IF NOT EXISTS hook_fires (
        fire_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, hook_type TEXT NOT NULL,
        session_id TEXT, duration_ms REAL, success INTEGER NOT NULL, error TEXT,
        payload_size INTEGER, project_id TEXT NOT NULL, org_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_hookf_ts       ON hook_fires(ts);
      CREATE INDEX IF NOT EXISTS idx_hookf_session  ON hook_fires(session_id, ts);
      CREATE INDEX IF NOT EXISTS idx_hookf_type_ts  ON hook_fires(hook_type, ts);

      CREATE TABLE IF NOT EXISTS query_logs (
        query_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, query_spec_json TEXT NOT NULL,
        intent TEXT, retrievers_json TEXT, fused_top_json TEXT,
        reranked_top_json TEXT, chosen_ids_json TEXT, used_ids_json TEXT,
        latency_ms REAL, confidence_score REAL,
        project_id TEXT NOT NULL, org_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_qlogs_ts   ON query_logs(ts);
      CREATE INDEX IF NOT EXISTS idx_qlogs_proj ON query_logs(project_id, ts);

      CREATE TABLE IF NOT EXISTS brain_session_events (
        event_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, session_id TEXT NOT NULL,
        event_type TEXT NOT NULL, payload_json TEXT,
        project_id TEXT NOT NULL, org_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_bse_ts      ON brain_session_events(ts);
      CREATE INDEX IF NOT EXISTS idx_bse_session ON brain_session_events(session_id, ts);
    `);
  },
};

const m007Triggers: BrainMigration = {
  id: 7,
  name: "007_append_only_triggers",
  up(db) {
    (db as unknown as ExecDb).exec(`
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

      CREATE TRIGGER IF NOT EXISTS trg_edges_no_cross_org BEFORE INSERT ON artifact_edges
      WHEN EXISTS (
        SELECT 1 FROM artifacts a1, artifacts a2
         WHERE a1.hash = new.from_hash AND a2.hash = new.to_hash
           AND a1.org_id <> a2.org_id
      )
      BEGIN SELECT RAISE(ABORT, 'cross-org artifact edges forbidden'); END;

      CREATE TRIGGER IF NOT EXISTS trg_thoughts_content_immutable
      BEFORE UPDATE OF content, metadata_json, source_kind, source_refs_json ON thoughts
        BEGIN SELECT RAISE(ABORT, 'thought content/metadata is immutable'); END;

      CREATE TRIGGER IF NOT EXISTS trg_no_delete_thoughts BEFORE DELETE ON thoughts
        BEGIN SELECT RAISE(ABORT, 'thoughts are append-only'); END;

      CREATE TRIGGER IF NOT EXISTS trg_no_delete_entities BEFORE DELETE ON entities
        BEGIN SELECT RAISE(ABORT, 'entities are append-only'); END;
    `);
  },
};

/**
 * Migration 8 (Phase 2 adjustment): relax the thoughts content-immutability
 * trigger so async metadata extraction can populate metadata_json and
 * thought_type. Content, source_kind, and source_refs_json stay immutable.
 */
const m008ThoughtsMetadataWritable: BrainMigration = {
  id: 8,
  name: "008_thoughts_metadata_writable",
  up(db) {
    (db as unknown as ExecDb).exec(`
      DROP TRIGGER IF EXISTS trg_thoughts_content_immutable;
      CREATE TRIGGER trg_thoughts_content_immutable
      BEFORE UPDATE OF content, source_kind, source_refs_json ON thoughts
        BEGIN SELECT RAISE(ABORT, 'thought content/source is immutable'); END;
    `);
  },
};

/**
 * Migration 9 (Phase 5-cont2): relax the artifacts immutability trigger so
 * extractors can enrich kind_specific_meta + compression without violating
 * the append-only rule on content / hash / kind / ts / origin / size /
 * project_id / org_id / schema_version.
 */
const m009ArtifactsMetaWritable: BrainMigration = {
  id: 9,
  name: "009_artifacts_meta_writable",
  up(db) {
    (db as unknown as ExecDb).exec(`
      DROP TRIGGER IF EXISTS trg_no_update_artifacts;
      CREATE TRIGGER trg_no_update_artifacts_core
      BEFORE UPDATE OF
        hash, kind, ts, org_id, project_id, session_id, turn_ord,
        origin_tool, origin_version, actor, content, content_type,
        size, schema_version
      ON artifacts
        BEGIN SELECT RAISE(ABORT, 'archive is append-only: artifact content/identity is immutable'); END;
    `);
  },
};

/**
 * Migration 10 (Phase 10): LLM-suggested thought_refs proposer queue.
 * Suggestions land here pending human review; approval inserts into
 * thought_refs with origin='llm_suggested_approved'.
 */
const m010ThoughtRefSuggestions: BrainMigration = {
  id: 10,
  name: "010_thought_ref_suggestions",
  up(db) {
    (db as unknown as ExecDb).exec(`
      CREATE TABLE IF NOT EXISTS thought_ref_suggestions (
        id              TEXT PRIMARY KEY,
        org_id          TEXT NOT NULL,
        project_id      TEXT NOT NULL,
        from_thought_id TEXT NOT NULL,
        to_thought_id   TEXT NOT NULL,
        relation        TEXT NOT NULL,
        confidence      REAL NOT NULL DEFAULT 0,
        cosine          REAL,
        justification   TEXT,
        proposer_model  TEXT NOT NULL DEFAULT 'haiku',
        created_at      INTEGER NOT NULL,
        reviewed        INTEGER NOT NULL DEFAULT 0,
        reviewed_at     INTEGER,
        decision        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_trs_unreviewed
        ON thought_ref_suggestions(org_id, project_id, reviewed, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_trs_pair
        ON thought_ref_suggestions(from_thought_id, to_thought_id, relation);
    `);
  },
};

/**
 * Migration 11 (Phase 10): entity merge proposal queue. Phase 4 already
 * supports `merged_into` direct sets; the queue lets a human review
 * proposed merges before applying.
 */
const m011EntityMergeProposals: BrainMigration = {
  id: 11,
  name: "011_entity_merge_proposals",
  up(db) {
    (db as unknown as ExecDb).exec(`
      CREATE TABLE IF NOT EXISTS entity_merge_proposals (
        id            TEXT PRIMARY KEY,
        org_id        TEXT NOT NULL,
        from_entity_id TEXT NOT NULL,
        to_entity_id  TEXT NOT NULL,
        confidence    REAL NOT NULL DEFAULT 0,
        rationale     TEXT,
        proposer      TEXT NOT NULL DEFAULT 'system',
        created_at    INTEGER NOT NULL,
        reviewed      INTEGER NOT NULL DEFAULT 0,
        reviewed_at   INTEGER,
        decision      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_emp_unreviewed
        ON entity_merge_proposals(org_id, reviewed, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_emp_pair
        ON entity_merge_proposals(from_entity_id, to_entity_id);
    `);
  },
};

/**
 * Phase 22-E — near-duplicate thought merge proposals. Mirrors the
 * entity_merge_proposals shape so the merge-queue admin UI can present
 * both kinds in one unified list.
 */
const m012ThoughtMergeProposals: BrainMigration = {
  id: 12,
  name: "012_thought_merge_proposals",
  up(db) {
    (db as unknown as ExecDb).exec(`
      CREATE TABLE IF NOT EXISTS thought_merge_proposals (
        id              TEXT PRIMARY KEY,
        org_id          TEXT NOT NULL,
        project_id      TEXT NOT NULL,
        from_thought_id TEXT NOT NULL,
        to_thought_id   TEXT NOT NULL,
        similarity      REAL NOT NULL DEFAULT 0,
        rationale       TEXT,
        proposer        TEXT NOT NULL DEFAULT 'embedding_dedup',
        created_at      INTEGER NOT NULL,
        reviewed        INTEGER NOT NULL DEFAULT 0,
        reviewed_at     INTEGER,
        decision        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tmp_unreviewed
        ON thought_merge_proposals(org_id, reviewed, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_tmp_pair
        ON thought_merge_proposals(from_thought_id, to_thought_id);
    `);
  },
};

/**
 * Slice 2 — sleep-time consolidator. Track when a thought was last recalled so
 * the nightly decay sweep can soft-archive thoughts unrecalled for 90+ days.
 * NULL means "never recalled since capture" — the decay query treats that as
 * created_at (COALESCE), so a thought that's never been read decays 90d after
 * capture. The content-immutability trigger only guards content/source_kind/
 * source_refs_json, so bumping last_recalled_at on read is allowed.
 */
const m013ThoughtRecallTracking: BrainMigration = {
  id: 13,
  name: "013_thought_recall_tracking",
  up(db) {
    const cols = (db as unknown as {
      prepare(sql: string): { all(): Array<{ name: string }> };
    })
      .prepare(`PRAGMA table_info(thoughts)`)
      .all()
      .map((c) => c.name);
    const ddl = db as unknown as ExecDb;
    if (!cols.includes("last_recalled_at")) {
      ddl.exec(`ALTER TABLE thoughts ADD COLUMN last_recalled_at INTEGER;`);
    }
    ddl.exec(
      `CREATE INDEX IF NOT EXISTS idx_thoughts_recall
         ON thoughts(org_id, visibility, last_recalled_at);`,
    );
  },
};

/**
 * Phase 22-F — explicit "keep" pin for the sleep-time consolidator. A thought
 * with pinned_at set is never auto-archived (neither by staleness nor by a
 * supersedes ref). Set by POST /api/brain/thoughts/unarchive (pin defaults
 * true) so a human's "bring this back" survives the next nightly sweep.
 * Unpin: UPDATE thoughts SET pinned_at = NULL WHERE id = ?.
 */
const m014ThoughtPinned: BrainMigration = {
  id: 14,
  name: "014_thought_pinned",
  up(db) {
    const cols = (db as unknown as {
      prepare(sql: string): { all(): Array<{ name: string }> };
    })
      .prepare(`PRAGMA table_info(thoughts)`)
      .all()
      .map((c) => c.name);
    if (!cols.includes("pinned_at")) {
      (db as unknown as ExecDb).exec(`ALTER TABLE thoughts ADD COLUMN pinned_at INTEGER;`);
    }
  },
};

export const ACTIVE_DB_MIGRATIONS: BrainMigration[] = [
  m001CoreArchive,
  m002Fts,
  m003FeatureStubs,
  m004Thoughts,
  m005Entities,
  m006TimeseriesEvents,
  m007Triggers,
  m008ThoughtsMetadataWritable,
  m009ArtifactsMetaWritable,
  m010ThoughtRefSuggestions,
  m011EntityMergeProposals,
  m012ThoughtMergeProposals,
  m013ThoughtRecallTracking,
  m014ThoughtPinned,
];
