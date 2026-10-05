import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { ModelRouter } from "../../orchestrator/model-router.js";
import { createTestDb, seedMultiOrg } from "../helpers/db.js";

describe("ModelRouter.resolveModel", () => {
  let db: Database.Database;
  let router: ModelRouter;
  let projectId: string;

  beforeEach(() => {
    db = createTestDb();
    router = new ModelRouter(db);
    projectId = seedMultiOrg(db).personal.projectId;
  });

  afterEach(() => db.close());

  it("returns 'opus' as the ultimate fallback in normal mode", () => {
    expect(router.resolveModel(undefined, undefined, projectId, "normal")).toBe("opus");
  });

  it("explicit > everything in normal mode", () => {
    expect(router.resolveModel("haiku", undefined, projectId, "normal")).toBe("haiku");
  });

  it("strategy node recommendation beats project default", () => {
    db.prepare(`UPDATE projects SET default_model = 'opus' WHERE id = ?`).run(projectId);
    db.prepare(`
      INSERT INTO strategy_nodes (id, project_id, org_id, type, title, recommended_model)
      VALUES ('n1', ?, 'org_personal', 'task', 'T', 'sonnet')
    `).run(projectId);

    expect(router.resolveModel(undefined, "n1", projectId, "normal")).toBe("sonnet");
  });

  it("project default beats fallback when no node recommendation", () => {
    db.prepare(`UPDATE projects SET default_model = 'haiku' WHERE id = ?`).run(projectId);
    expect(router.resolveModel(undefined, undefined, projectId, "normal")).toBe("haiku");
  });

  it("critical pacing forces haiku regardless of preference", () => {
    expect(router.resolveModel("opus", undefined, projectId, "critical")).toBe("haiku");
    expect(router.resolveModel("sonnet", undefined, projectId, "critical")).toBe("haiku");
  });

  it("slow pacing downgrades opus to sonnet but respects explicit haiku", () => {
    expect(router.resolveModel("opus", undefined, projectId, "slow")).toBe("sonnet");
    expect(router.resolveModel("haiku", undefined, projectId, "slow")).toBe("haiku");
  });

  it("slow pacing downgrades fallback opus to sonnet", () => {
    expect(router.resolveModel(undefined, undefined, projectId, "slow")).toBe("sonnet");
  });

  it("cautious pacing has no effect — uses normal chain", () => {
    expect(router.resolveModel(undefined, undefined, projectId, "cautious")).toBe("opus");
  });
});

describe("ModelRouter.getNodeModel", () => {
  let db: Database.Database;
  let router: ModelRouter;
  let projectId: string;

  beforeEach(() => {
    db = createTestDb();
    router = new ModelRouter(db);
    projectId = seedMultiOrg(db).personal.projectId;
  });

  afterEach(() => db.close());

  it("returns null for undefined nodeId", () => {
    expect(router.getNodeModel(undefined)).toBeNull();
  });

  it("returns null when node has no recommendation", () => {
    db.prepare(`
      INSERT INTO strategy_nodes (id, project_id, org_id, type, title)
      VALUES ('n1', ?, 'org_personal', 'task', 'T')
    `).run(projectId);
    expect(router.getNodeModel("n1")).toBeNull();
  });

  it("returns the recommended_model when set", () => {
    db.prepare(`
      INSERT INTO strategy_nodes (id, project_id, org_id, type, title, recommended_model)
      VALUES ('n1', ?, 'org_personal', 'task', 'T', 'haiku')
    `).run(projectId);
    expect(router.getNodeModel("n1")).toBe("haiku");
  });
});

describe("ModelRouter.getProjectModel", () => {
  let db: Database.Database;
  let router: ModelRouter;
  let projectId: string;

  beforeEach(() => {
    db = createTestDb();
    router = new ModelRouter(db);
    projectId = seedMultiOrg(db).personal.projectId;
  });

  afterEach(() => db.close());

  it("returns the default_model from projects", () => {
    db.prepare(`UPDATE projects SET default_model = 'sonnet' WHERE id = ?`).run(projectId);
    expect(router.getProjectModel(projectId)).toBe("sonnet");
  });
});
