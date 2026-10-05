import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb } from "../helpers/db.js";
import { storeMemory, retrieveMemory } from "../../memory-ops.js";

const ORG_ID = "org_personal";

describe("storeMemory", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("stores a new memory entry", () => {
    const result = storeMemory(db, ORG_ID, {
      category: "fact",
      key: "test-key",
      value: "test-value",
    });

    expect(result.content[0].text).toContain("Stored memory");
    expect(result.content[0].text).toContain("[fact]");
    expect(result.content[0].text).toContain("test-key");

    // Verify it was actually persisted
    const row = db
      .prepare("SELECT * FROM memory WHERE org_id = ? AND key = ?")
      .get(ORG_ID, "test-key") as { value: string; project_id: string | null };
    expect(row).toBeDefined();
    expect(row.value).toBe("test-value");
    expect(row.project_id).toBeNull();
  });

  it("upserts on conflict (same org+project+category+key) with non-null project", () => {
    storeMemory(db, ORG_ID, {
      category: "decision",
      key: "framework",
      value: "React",
      project: "proj_1",
    });

    storeMemory(db, ORG_ID, {
      category: "decision",
      key: "framework",
      value: "Vue",
      project: "proj_1",
    });

    const rows = db
      .prepare(
        "SELECT * FROM memory WHERE org_id = ? AND key = ? AND category = ? AND project_id = ?"
      )
      .all(ORG_ID, "framework", "decision", "proj_1") as Array<{ value: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe("Vue");
  });

  it("upserts org-wide memory when project is null", () => {
    storeMemory(db, ORG_ID, {
      category: "decision",
      key: "framework",
      value: "React",
    });

    storeMemory(db, ORG_ID, {
      category: "decision",
      key: "framework",
      value: "Vue",
    });

    const rows = db
      .prepare(
        "SELECT * FROM memory WHERE org_id = ? AND key = ? AND category = ? AND project_id IS NULL"
      )
      .all(ORG_ID, "framework", "decision") as Array<{ value: string }>;

    // Fixed: two-step upsert handles NULL project_id correctly
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe("Vue");
  });

  it("stores org-wide memory when project is omitted", () => {
    storeMemory(db, ORG_ID, {
      category: "fact",
      key: "org-wide-key",
      value: "org-wide-value",
    });

    const row = db
      .prepare("SELECT project_id FROM memory WHERE org_id = ? AND key = ?")
      .get(ORG_ID, "org-wide-key") as { project_id: string | null };

    expect(row.project_id).toBeNull();
  });

  it("stores project-scoped memory when project is provided", () => {
    storeMemory(db, ORG_ID, {
      category: "skill",
      key: "project-key",
      value: "project-value",
      project: "proj_abc",
    });

    const row = db
      .prepare("SELECT project_id FROM memory WHERE org_id = ? AND key = ?")
      .get(ORG_ID, "project-key") as { project_id: string | null };

    expect(row.project_id).toBe("proj_abc");
  });

  it("allows same key in different categories", () => {
    storeMemory(db, ORG_ID, {
      category: "fact",
      key: "same-key",
      value: "fact-value",
    });

    storeMemory(db, ORG_ID, {
      category: "decision",
      key: "same-key",
      value: "decision-value",
    });

    const rows = db
      .prepare("SELECT * FROM memory WHERE org_id = ? AND key = ?")
      .all(ORG_ID, "same-key") as Array<{ category: string }>;

    expect(rows).toHaveLength(2);
  });

  it("allows same key in different projects", () => {
    storeMemory(db, ORG_ID, {
      category: "fact",
      key: "shared-key",
      value: "value-a",
      project: "proj_a",
    });

    storeMemory(db, ORG_ID, {
      category: "fact",
      key: "shared-key",
      value: "value-b",
      project: "proj_b",
    });

    const rows = db
      .prepare("SELECT * FROM memory WHERE org_id = ? AND key = ? AND category = ?")
      .all(ORG_ID, "shared-key", "fact") as Array<{ project_id: string | null }>;

    expect(rows).toHaveLength(2);
  });
});
