import { describe, it, expect } from "vitest";
import { createTestDb } from "../helpers/db.js";

describe("initializeDatabase", () => {
  it("returns a valid Database object", () => {
    const db = createTestDb();
    expect(db).toBeDefined();
    expect(db.open).toBe(true);
    db.close();
  });

  it("creates all expected tables", () => {
    const db = createTestDb();

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);

    const expectedTables = [
      "organizations",
      "accounts",
      "projects",
      "sessions",
      "goals",
      "strategy_nodes",
      "alerts",
      "token_usage",
      "memory",
      "push_devices",
    ];

    for (const table of expectedTables) {
      expect(tableNames).toContain(table);
    }

    db.close();
  });

  it("seeds all 3 organizations automatically", () => {
    const db = createTestDb();

    const orgs = db.prepare("SELECT id, slug FROM organizations ORDER BY slug").all() as Array<{
      id: string;
      slug: string;
    }>;

    expect(orgs).toHaveLength(3);
    expect(orgs.map((o) => o.slug)).toEqual(["apply", "personal", "wyobi"]);
    expect(orgs.map((o) => o.id)).toEqual(["org_apply", "org_personal", "org_wyobi"]);

    db.close();
  });

  it("enforces foreign keys", () => {
    const db = createTestDb();

    // Verify foreign keys are enabled
    const fkResult = db.pragma("foreign_keys") as Array<{ foreign_keys: number }>;
    expect(fkResult[0].foreign_keys).toBe(1);

    // Attempting to insert an account with a non-existent org_id should throw
    expect(() => {
      db.prepare(
        "INSERT INTO accounts (id, org_id, name, type) VALUES (?, ?, ?, ?)"
      ).run("acc_bad", "org_nonexistent", "Bad Account", "pro");
    }).toThrow(/FOREIGN KEY/);

    db.close();
  });

  it("creates indexes for common queries", () => {
    const db = createTestDb();

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
      .all() as Array<{ name: string }>;

    const indexNames = indexes.map((i) => i.name);

    expect(indexNames).toContain("idx_accounts_org");
    expect(indexNames).toContain("idx_projects_org");
    expect(indexNames).toContain("idx_sessions_project");
    expect(indexNames).toContain("idx_strategy_org");

    db.close();
  });
});
