import { initializeDatabase } from "../../../../server/src/db/schema.js";
import type Database from "better-sqlite3";
import { nanoid } from "nanoid";

export function createTestDb(): Database.Database {
  const db = initializeDatabase(":memory:");
  return db;
}

export interface SeededMemory {
  id: string;
  orgId: string;
  projectId: string | null;
  category: string;
  key: string;
  value: string;
}

export function seedMemoryData(
  db: Database.Database,
  orgId: string
): SeededMemory[] {
  const now = new Date().toISOString();
  const entries: SeededMemory[] = [
    {
      id: nanoid(),
      orgId,
      projectId: null,
      category: "fact",
      key: "db-engine",
      value: "We use SQLite with WAL mode for the main database",
    },
    {
      id: nanoid(),
      orgId,
      projectId: null,
      category: "decision",
      key: "monorepo-choice",
      value: "Chose npm workspaces over turborepo for simplicity",
    },
    {
      id: nanoid(),
      orgId,
      projectId: "proj_test_1",
      category: "skill",
      key: "vitest-mocking",
      value: "Use vi.mock for module mocking in vitest tests",
    },
    {
      id: nanoid(),
      orgId,
      projectId: "proj_test_1",
      category: "pattern",
      key: "repository-pattern",
      value: "All DB access goes through repository classes for testability",
    },
  ];

  const stmt = db.prepare(`
    INSERT INTO memory (id, org_id, project_id, category, key, value, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const e of entries) {
    stmt.run(e.id, e.orgId, e.projectId, e.category, e.key, e.value, now, now);
  }

  return entries;
}
