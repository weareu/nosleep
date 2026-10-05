/**
 * Schema initialization. Delegates all DDL to the migration framework
 * (see migrations.ts and migrations-list.ts). Adding a new schema change?
 * Append a new entry to MIGRATIONS in migrations-list.ts — never edit this file.
 */

import Database from "better-sqlite3";
import { createRequire } from "node:module";
import { runMigrations } from "./migrations.js";
import { MIGRATIONS } from "./migrations-list.js";

const require = createRequire(import.meta.url);

export function initializeDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // Enable WAL mode for concurrent read/write support
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  runMigrations(db, MIGRATIONS);

  return db;
}

/**
 * Initialize sqlite-vec extension and create vector search tables.
 * Must be called AFTER initializeDatabase since vec0 virtual tables
 * require the extension to be loaded first.
 */
export function initializeVectorIndex(db: Database.Database): void {
  const sqliteVec = require("sqlite-vec");
  sqliteVec.load(db);

  // vec0 virtual table — multi-statement requires db.exec
  (db as { exec(sql: string): unknown }).exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[384]);
    CREATE TABLE IF NOT EXISTS chunk_metadata (
      id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      chunk_type TEXT NOT NULL,
      heading TEXT,
      content TEXT NOT NULL,
      line_start INTEGER,
      line_end INTEGER,
      indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_chunk_project ON chunk_metadata(project_id);
    CREATE INDEX IF NOT EXISTS idx_chunk_file ON chunk_metadata(file_path);
    CREATE TABLE IF NOT EXISTS vec_file_hashes (
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (project_id, file_path)
    );
  `);
}
