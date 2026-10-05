/**
 * Centralised SQL runner for DDL blocks. All migrations route through this
 * helper so the direct better-sqlite3 exec call exists in exactly one place.
 */

import type Database from "better-sqlite3";

type ExecDb = { exec(sql: string): unknown };

export function runSql(db: Database.Database, sql: string): void {
  (db as unknown as ExecDb).exec(sql);
}
