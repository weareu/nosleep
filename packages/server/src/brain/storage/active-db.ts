/**
 * Open and cache active.db connections per org.
 * Applies migrations on first open.
 */

import Database from "better-sqlite3";
import { brainPathsFor } from "./paths.js";
import { runBrainMigrations } from "./migrations.js";
import { ACTIVE_DB_MIGRATIONS } from "./active-migrations.js";
import { loadBrainVecExtension } from "./vec-loader.js";

const cache = new Map<string, Database.Database>();

export function activeDbFor(orgId: string): Database.Database {
  const cached = cache.get(orgId);
  if (cached) return cached;

  const paths = brainPathsFor(orgId);
  const db = new Database(paths.activeDb);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = OFF"); // we enforce via triggers, not FKs
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = -64000"); // 64 MB
  db.pragma("mmap_size = 268435456"); // 256 MB
  // Cap the WAL file: without this it only shrinks on a TRUNCATE checkpoint,
  // and under constant ingest it grew to 8.4 GB (2026-08-06) — nearly half
  // the brain's disk footprint — repeatedly tripping the low-disk ingest
  // pause. 64 MB bounds it while keeping checkpoint frequency reasonable.
  db.pragma("journal_size_limit = 67108864"); // 64 MB
  db.pragma("wal_autocheckpoint = 2000"); // pages (~8 MB at 4k) — default 1000, explicit

  runBrainMigrations(db, ACTIVE_DB_MIGRATIONS);
  loadBrainVecExtension(db);

  cache.set(orgId, db);
  return db;
}

export function closeAllBrainDbs(): void {
  for (const db of cache.values()) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  cache.clear();
}
