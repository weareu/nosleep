/**
 * Brain-specific migration runner. Mirrors the pattern in
 * packages/server/src/db/migrations.ts but scoped to per-org active.db and
 * catalog.db.
 */

import type Database from "better-sqlite3";

export interface BrainMigration {
  id: number;
  name: string;
  up: (db: Database.Database) => void;
}

export function runBrainMigrations(
  db: Database.Database,
  migrations: BrainMigration[],
): void {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS _brain_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )`,
  ).run();

  const applied = new Set(
    (db.prepare("SELECT id FROM _brain_migrations").all() as { id: number }[]).map(
      (r) => r.id,
    ),
  );

  const ordered = [...migrations].sort((a, b) => a.id - b.id);

  for (const m of ordered) {
    if (applied.has(m.id)) continue;
    const tx = db.transaction(() => {
      m.up(db);
      db.prepare(
        "INSERT INTO _brain_migrations (id, name, applied_at) VALUES (?, ?, ?)",
      ).run(m.id, m.name, Math.floor(Date.now() / 1000));
    });
    tx();
  }
}
