/**
 * Sequential migration framework.
 *
 * Each migration has a version number, a name, and an idempotent up(). The
 * runner tracks applied versions in `schema_migrations`. Migrations run in
 * order, each wrapped in a transaction.
 *
 * IDEMPOTENCE: every up() MUST be safe to re-run. This protects DBs that
 * predate the migration framework — they already have every column, but on
 * the first run we still execute every up(). `IF NOT EXISTS` clauses and
 * `safeAlter` catch duplicate-column errors.
 */

import type Database from "better-sqlite3";
import { getLogger } from "../logger.js";

const log = getLogger("migrations");

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: Database.Database) => void;
}

/**
 * Run an ALTER TABLE that may have already been applied (e.g. on legacy DBs).
 * Swallows "duplicate column" errors only — every other SQL error throws.
 */
export function safeAlter(db: Database.Database, sql: string): void {
  try {
    db.prepare(sql).run();
  } catch (err) {
    const msg = (err as Error).message;
    if (!msg.includes("duplicate column")) throw err;
  }
}

/**
 * Run a list of migrations against the DB. Idempotent.
 */
export function runMigrations(db: Database.Database, migrations: readonly Migration[]): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();

  const appliedRows = db.prepare(`SELECT version FROM schema_migrations`).all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map((r) => r.version));

  // Validate ordering — versions must be strictly ascending and unique
  let lastSeen = -1;
  for (const m of migrations) {
    if (m.version <= lastSeen) {
      throw new Error(`Migration versions must be strictly ascending: saw ${m.version} after ${lastSeen}`);
    }
    lastSeen = m.version;
  }

  const insertApplied = db.prepare(`INSERT INTO schema_migrations (version, name) VALUES (?, ?)`);

  let appliedCount = 0;
  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      m.up(db);
      insertApplied.run(m.version, m.name);
    })();
    appliedCount++;
    log.info({ version: m.version, name: m.name }, "applied migration");
  }

  if (appliedCount === 0) {
    log.debug({ totalMigrations: migrations.length }, "no migrations to apply");
  } else {
    log.info({ appliedCount, totalMigrations: migrations.length }, "migrations complete");
  }
}

/**
 * Read the current applied schema version. Returns 0 if no migrations have run.
 */
export function getCurrentSchemaVersion(db: Database.Database): number {
  const row = db.prepare(`
    SELECT COALESCE(MAX(version), 0) as max_version FROM schema_migrations
  `).get() as { max_version: number } | undefined;
  return row?.max_version ?? 0;
}
