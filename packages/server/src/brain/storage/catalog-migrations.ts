/**
 * catalog.db — mutable metadata per org. Rebuildable from sealed files.
 * Hosts project visibility, sealed-file registry, kind review queue, brain config.
 */

import type { BrainMigration } from "./migrations.js";
import { runSql } from "./run-sql.js";

const m001Catalog: BrainMigration = {
  id: 1,
  name: "001_catalog",
  up(db) {
    runSql(db, `
      CREATE TABLE IF NOT EXISTS projects (
        project_id        TEXT PRIMARY KEY,
        org_id            TEXT NOT NULL,
        name              TEXT NOT NULL,
        visibility        TEXT NOT NULL DEFAULT 'active',
        hidden_reason     TEXT,
        hidden_at         INTEGER,
        hidden_by         TEXT,
        created_at        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_catalog_projects_vis ON projects(visibility);

      CREATE TABLE IF NOT EXISTS sealed_files (
        file_name         TEXT PRIMARY KEY,
        org_id            TEXT NOT NULL,
        quarter           TEXT NOT NULL,
        ts_from           INTEGER NOT NULL,
        ts_to             INTEGER NOT NULL,
        size_bytes        INTEGER,
        artifact_count    INTEGER,
        verify_hash       TEXT,
        verified_at       INTEGER,
        compression_ratio REAL
      );
      CREATE INDEX IF NOT EXISTS idx_catalog_sealed_range ON sealed_files(ts_from, ts_to);

      CREATE TABLE IF NOT EXISTS catalog_files (
        project_id        TEXT NOT NULL,
        file_name         TEXT NOT NULL,
        has_data          INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (project_id, file_name)
      );
      CREATE INDEX IF NOT EXISTS idx_catalog_files_file ON catalog_files(file_name);

      CREATE TABLE IF NOT EXISTS kind_review_queue (
        kind              TEXT PRIMARY KEY,
        first_seen_ts     INTEGER NOT NULL,
        sample_hash       TEXT,
        count             INTEGER NOT NULL DEFAULT 1,
        resolved          INTEGER NOT NULL DEFAULT 0,
        resolution        TEXT
      );

      CREATE TABLE IF NOT EXISTS brain_config (
        key               TEXT PRIMARY KEY,
        value_json        TEXT NOT NULL,
        updated_at        INTEGER NOT NULL
      );
    `);
  },
};

export const CATALOG_DB_MIGRATIONS: BrainMigration[] = [m001Catalog];
