import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type Database from "better-sqlite3";
import { initializeDatabase } from "./schema.js";

let db: Database.Database | null = null;

export function getDb(dbPath: string): Database.Database {
  if (db) return db;

  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  db = initializeDatabase(dbPath);
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
