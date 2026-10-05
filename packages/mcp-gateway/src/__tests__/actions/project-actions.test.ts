import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { buildActions, dispatch, type Action } from "../../actions.js";
import { createTestDb, seedGatewayData } from "../helpers/db.js";

describe("project actions", () => {
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

  describe("project_list", () => {
    it("returns projects for org", async () => {
      const result = await dispatch(actions, "project_list", undefined, { orgId: "org_personal" });
      expect(result.text).toContain("# Projects [Personal]");
      expect(result.text).toContain("My Side Project");
      expect(result.text).toContain("500,000");
    });

    it("returns projects for wyobi org", async () => {
      const result = await dispatch(actions, "project_list", undefined, { orgId: "org_wyobi" });
      expect(result.text).toContain("# Projects [Wyobi]");
      expect(result.text).toContain("Work Dashboard");
    });

    it("requires orgId", async () => {
      const result = await dispatch(actions, "project_list", undefined, {});
      expect(result.text).toContain("Pass orgId");
    });

    it("returns empty message for org with no projects", async () => {
      const result = await dispatch(actions, "project_list", undefined, { orgId: "org_apply" });
      expect(result.text).toContain("No projects in Apply");
    });

    it("resolves org by slug", async () => {
      const result = await dispatch(actions, "project_list", undefined, { orgId: "personal" });
      expect(result.text).toContain("My Side Project");
    });
  });

  describe("project_update", () => {
    it("updates name field", async () => {
      const result = await dispatch(actions, "project_update", undefined, {
        projectId: seed.projectPersonalId,
        name: "Renamed Project",
      });
      expect(result.text).toContain('Updated "My Side Project"');

      // Verify in DB
      const row = db.prepare(`SELECT name FROM projects WHERE id = ?`).get(seed.projectPersonalId) as { name: string };
      expect(row.name).toBe("Renamed Project");
    });

    it("updates token budget", async () => {
      const result = await dispatch(actions, "project_update", undefined, {
        projectId: seed.projectPersonalId,
        tokenBudget: 1000000,
      });
      expect(result.text).toContain("Updated");

      const row = db.prepare(`SELECT token_budget FROM projects WHERE id = ?`).get(seed.projectPersonalId) as { token_budget: number };
      expect(row.token_budget).toBe(1000000);
    });

    it("updates autonomy level", async () => {
      const result = await dispatch(actions, "project_update", undefined, {
        projectId: seed.projectPersonalId,
        autonomyLevel: "full",
      });
      expect(result.text).toContain("Updated");

      const row = db.prepare(`SELECT autonomy_level FROM projects WHERE id = ?`).get(seed.projectPersonalId) as { autonomy_level: string };
      expect(row.autonomy_level).toBe("full");
    });

    it("returns error for nonexistent project", async () => {
      const result = await dispatch(actions, "project_update", undefined, {
        projectId: "nonexistent",
        name: "Test",
      });
      expect(result.text).toBe("Project not found.");
    });

    it("returns error when no fields provided", async () => {
      const result = await dispatch(actions, "project_update", undefined, {
        projectId: seed.projectPersonalId,
      });
      expect(result.text).toBe("No fields to update.");
    });
  });
});
