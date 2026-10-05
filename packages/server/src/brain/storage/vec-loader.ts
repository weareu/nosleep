/**
 * Load sqlite-vec extension into a brain DB and create the vec0 virtual
 * tables we need. Called once per brain active.db after migrations.
 *
 * vec0 virtual tables are declared here (not in migrations) because the
 * extension must be loaded at runtime before CREATE VIRTUAL TABLE fires.
 * Idempotent via IF NOT EXISTS.
 */

import type Database from "better-sqlite3";
import { createRequire } from "node:module";
import { runSql } from "./run-sql.js";

const require = createRequire(import.meta.url);

type ExecDb = { exec(sql: string): unknown };

let loaded = new WeakSet<object>();

export function loadBrainVecExtension(db: Database.Database): void {
  if (loaded.has(db)) return;
  try {
    const sqliteVec = require("sqlite-vec");
    sqliteVec.load(db);
  } catch {
    // Extension unavailable — brain continues without semantic search. The
    // semantic retriever gracefully returns empty results in this case.
    loaded.add(db);
    return;
  }

  // 384-dim matches the existing minilm embedder in packages/server/src/embeddings.
  runSql(
    db,
    `CREATE VIRTUAL TABLE IF NOT EXISTS vec_text USING vec0(embedding float[384]);`,
  );
  // Phase 12 (G1) — parallel 1024-dim table for bge-m3. Empty until the
  // bge-m3 provider lands + a backfill is run. Gives queries a place to
  // route once the new embeddings start landing without disturbing the
  // existing minilm pipeline.
  runSql(
    db,
    `CREATE VIRTUAL TABLE IF NOT EXISTS vec_text_1024 USING vec0(embedding float[1024]);`,
  );
  runSql(
    db,
    `CREATE TABLE IF NOT EXISTS vec_text_1024_map (
       rowid          INTEGER PRIMARY KEY,
       hash           TEXT NOT NULL,
       referrer_kind  TEXT NOT NULL CHECK(referrer_kind IN ('artifact','thought')),
       chunk_ord      INTEGER NOT NULL DEFAULT 0,
       chunk_text     TEXT,
       model          TEXT NOT NULL DEFAULT 'bge-m3',
       embedded_at    INTEGER NOT NULL
     );
     CREATE INDEX IF NOT EXISTS idx_vec_text_1024_map_hash
       ON vec_text_1024_map(hash, referrer_kind);`,
  );
  runSql(
    db,
    `CREATE VIRTUAL TABLE IF NOT EXISTS vec_clip USING vec0(embedding float[512]);`,
  );

  loaded.add(db);
}

export function isVecLoaded(db: Database.Database): boolean {
  // Probe via sqlite_master rather than our WeakSet so we survive across
  // test setups that re-open the DB.
  const row = (db as unknown as ExecDb).exec;
  void row;
  try {
    const r = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='vec_text'`,
      )
      .get();
    return !!r;
  } catch {
    return false;
  }
}
