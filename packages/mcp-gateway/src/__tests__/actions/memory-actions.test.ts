import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { buildActions, dispatch, type Action } from "../../actions.js";
import { createTestDb, seedGatewayData } from "../helpers/db.js";

describe("memory actions", () => {
  let db: Database.Database;
  let actions: Action[];
  let seed: ReturnType<typeof seedGatewayData>;

  beforeEach(() => {
    db = createTestDb();
    seed = seedGatewayData(db);
    actions = buildActions({
      db,
      serverUrl: "http://localhost:3777",
      apiKey: "test-key",
    });
  });

  afterEach(() => {
    db.close();
  });

  describe("memory_store", () => {
    it("inserts a new memory entry", async () => {
      const result = await dispatch(actions, "memory_store", undefined, {
        orgId: "org_personal",
        category: "fact",
        key: "db-engine",
        value: "We use SQLite for everything",
      });
      expect(result.text).toContain("Stored [personal] [fact] db-engine");

      const row = db.prepare(`SELECT * FROM memory WHERE key = 'db-engine' AND org_id = 'org_personal'`).get() as Record<string, unknown>;
      expect(row).toBeDefined();
      expect(row.value).toBe("We use SQLite for everything");
      expect(row.category).toBe("fact");
    });

    it("upserts on conflict (same org, project, category, key)", async () => {
      // Use a non-null project so the UNIQUE constraint fires
      // (SQLite treats NULLs as distinct in UNIQUE constraints)
      const projectId = seed.projectPersonalId;

      // First insert with project
      await dispatch(actions, "memory_store", undefined, {
        orgId: "org_personal",
        category: "skill",
        key: "upsert-test",
        value: "Original value",
        project: projectId,
      });

      // Verify it was inserted
      const before = db.prepare(`SELECT * FROM memory WHERE key = 'upsert-test' AND org_id = 'org_personal' AND project_id = ?`).all(projectId);
      expect(before.length).toBe(1);

      // Upsert with same org, project, category, key
      const result = await dispatch(actions, "memory_store", undefined, {
        orgId: "org_personal",
        category: "skill",
        key: "upsert-test",
        value: "Updated value",
        project: projectId,
      });
      expect(result.text).toContain("Stored");

      // Should still be one row, with the updated value
      const after = db.prepare(`SELECT * FROM memory WHERE key = 'upsert-test' AND org_id = 'org_personal' AND project_id = ?`).all(projectId);
      expect(after.length).toBe(1);
      expect((after[0] as Record<string, unknown>).value).toBe("Updated value");
    });

    it("requires orgId", async () => {
      const result = await dispatch(actions, "memory_store", undefined, {
        category: "fact",
        key: "test",
        value: "test",
      });
      expect(result.text).toContain("Pass orgId");
    });
  });

  describe("memory_search", () => {
    it("finds memories by keyword in key", async () => {
      const result = await dispatch(actions, "memory_search", undefined, {
        orgId: "org_personal",
        query: "sqlite",
      });
      expect(result.text).toContain("use-sqlite");
      expect(result.text).toContain("SQLite");
    });

    it("finds memories by keyword in value", async () => {
      const result = await dispatch(actions, "memory_search", undefined, {
        orgId: "org_personal",
        query: "vitest",
      });
      expect(result.text).toContain("vitest-config");
    });

    it("returns empty message when no matches", async () => {
      const result = await dispatch(actions, "memory_search", undefined, {
        orgId: "org_personal",
        query: "nonexistent_keyword_xyz",
      });
      expect(result.text).toContain("No memories matching");
    });

    it("filters by category", async () => {
      const result = await dispatch(actions, "memory_search", undefined, {
        orgId: "org_personal",
        query: "sqlite",
        category: "skill",
      });
      // "use-sqlite" is a decision, not a skill, so should not match category filter
      expect(result.text).toContain("No memories matching");
    });
  });

  describe("memory_list", () => {
    it("returns all memories for org", async () => {
      const result = await dispatch(actions, "memory_list", undefined, {
        orgId: "org_personal",
      });
      expect(result.text).toContain("use-sqlite");
      expect(result.text).toContain("vitest-config");
      expect(result.text).toContain("[decision]");
      expect(result.text).toContain("[skill]");
    });

    it("filters by category", async () => {
      const result = await dispatch(actions, "memory_list", undefined, {
        orgId: "org_personal",
        category: "decision",
      });
      expect(result.text).toContain("use-sqlite");
      expect(result.text).not.toContain("vitest-config");
    });

    it("returns empty message for org with no memories", async () => {
      const result = await dispatch(actions, "memory_list", undefined, {
        orgId: "org_apply",
      });
      expect(result.text).toContain("No memories in Apply");
    });
  });

  describe("memory_delete", () => {
    it("removes an existing entry", async () => {
      const result = await dispatch(actions, "memory_delete", undefined, {
        orgId: "org_personal",
        id: seed.memoryId1,
      });
      expect(result.text).toBe("Deleted.");

      const row = db.prepare(`SELECT * FROM memory WHERE id = ?`).get(seed.memoryId1);
      expect(row).toBeUndefined();
    });

    it("returns not found for nonexistent id", async () => {
      const result = await dispatch(actions, "memory_delete", undefined, {
        orgId: "org_personal",
        id: "nonexistent",
      });
      expect(result.text).toContain("Not found");
    });

    it("cannot delete memory from a different org", async () => {
      // Try to delete personal memory using wyobi org
      const result = await dispatch(actions, "memory_delete", undefined, {
        orgId: "org_wyobi",
        id: seed.memoryId1,
      });
      expect(result.text).toContain("Not found");

      // Verify it still exists
      const row = db.prepare(`SELECT * FROM memory WHERE id = ?`).get(seed.memoryId1);
      expect(row).toBeDefined();
    });
  });

  describe("org isolation", () => {
    it("personal memory is not visible in wyobi search", async () => {
      const result = await dispatch(actions, "memory_search", undefined, {
        orgId: "org_wyobi",
        query: "sqlite",
      });
      // "use-sqlite" belongs to org_personal, should not appear
      expect(result.text).not.toContain("use-sqlite");
    });

    it("wyobi memory is not visible in personal search", async () => {
      const result = await dispatch(actions, "memory_search", undefined, {
        orgId: "org_personal",
        query: "deploy-target",
      });
      expect(result.text).toContain("No memories matching");
    });

    it("memory_list only shows own org", async () => {
      const result = await dispatch(actions, "memory_list", undefined, {
        orgId: "org_wyobi",
      });
      expect(result.text).toContain("deploy-target");
      expect(result.text).not.toContain("use-sqlite");
      expect(result.text).not.toContain("vitest-config");
    });
  });
});
