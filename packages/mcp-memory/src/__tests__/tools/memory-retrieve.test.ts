import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, seedMemoryData, type SeededMemory } from "../helpers/db.js";
import { retrieveMemory, storeMemory } from "../../memory-ops.js";

const ORG_ID = "org_personal";

describe("retrieveMemory", () => {
  let db: Database.Database;
  let seeded: SeededMemory[];

  beforeEach(() => {
    db = createTestDb();
    seeded = seedMemoryData(db, ORG_ID);
  });

  it("searches by keyword in key", () => {
    const result = retrieveMemory(db, ORG_ID, {
      query: "db-engine",
      limit: 10,
    });

    expect(result.content[0].text).toContain("db-engine");
    expect(result.content[0].text).toContain("SQLite");
  });

  it("searches by keyword in value", () => {
    const result = retrieveMemory(db, ORG_ID, {
      query: "WAL mode",
      limit: 10,
    });

    expect(result.content[0].text).toContain("db-engine");
    expect(result.content[0].text).toContain("WAL mode");
  });

  it("filters by category", () => {
    const result = retrieveMemory(db, ORG_ID, {
      query: "e",
      category: "skill",
      limit: 10,
    });

    expect(result.content[0].text).toContain("vitest-mocking");
    expect(result.content[0].text).not.toContain("db-engine");
    expect(result.content[0].text).not.toContain("monorepo-choice");
  });

  it("filters by project and includes org-wide memories", () => {
    const result = retrieveMemory(db, ORG_ID, {
      query: "e",
      project: "proj_test_1",
      limit: 10,
    });

    const text = result.content[0].text;
    // Should include project-scoped entries
    expect(text).toContain("vitest-mocking");
    expect(text).toContain("repository-pattern");
    // Should also include org-wide entries (project_id IS NULL)
    expect(text).toContain("db-engine");
    expect(text).toContain("monorepo-choice");
  });

  it("respects limit", () => {
    const result = retrieveMemory(db, ORG_ID, {
      query: "e",
      limit: 2,
    });

    // Count the number of entries in the result by counting separators
    const sections = result.content[0].text.split("---");
    expect(sections.length).toBeLessThanOrEqual(2);
  });

  it("returns empty message for no matches", () => {
    const result = retrieveMemory(db, ORG_ID, {
      query: "xyznonexistent",
      limit: 10,
    });

    expect(result.content[0].text).toContain("No memories found");
  });

  it("increments access_count on retrieval", () => {
    const entry = seeded[0];

    // Access count should start at 0
    const before = db
      .prepare("SELECT access_count FROM memory WHERE id = ?")
      .get(entry.id) as { access_count: number };
    expect(before.access_count).toBe(0);

    retrieveMemory(db, ORG_ID, { query: entry.key, limit: 10 });

    const after = db
      .prepare("SELECT access_count FROM memory WHERE id = ?")
      .get(entry.id) as { access_count: number };
    expect(after.access_count).toBe(1);
  });
});
