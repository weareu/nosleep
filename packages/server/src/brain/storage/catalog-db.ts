/**
 * Open and cache catalog.db connections per org.
 */

import Database from "better-sqlite3";
import { brainPathsFor } from "./paths.js";
import { runBrainMigrations } from "./migrations.js";
import { CATALOG_DB_MIGRATIONS } from "./catalog-migrations.js";

const cache = new Map<string, Database.Database>();

export function catalogDbFor(orgId: string): Database.Database {
  const cached = cache.get(orgId);
  if (cached) return cached;

  const paths = brainPathsFor(orgId);
  const db = new Database(paths.catalogDb);

  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");

  runBrainMigrations(db, CATALOG_DB_MIGRATIONS);

  cache.set(orgId, db);
  return db;
}
