import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { buildActions, dispatch, type Action } from "../../actions.js";
import { createTestDb, seedGatewayData } from "../helpers/db.js";

/**
 * Regression: an explicit projectId must resolve the org FROM THE PROJECT, not
 * from the caller's session org. Before this, a session bound to org_personal
 * querying a Wyobi project's tree got filtered to zero rows and lied with
 * "No strategy tree" (a real incident: a large tree reported as empty).
 */
describe("project-scoped strategy reads resolve org from the project", () => {
  let db: Database.Database;
  let actions: Action[];
  let wyobiProject: string;

  beforeEach(() => {
    db = createTestDb();
    const seed = seedGatewayData(db);
    wyobiProject = seed.projectWyobiId;
    db.prepare(
      `INSERT INTO strategy_nodes (id, project_id, org_id, parent_id, type, title, status, depth, sort_order)
       VALUES ('wn1', ?, 'org_wyobi', NULL, 'task', 'Wyobi-only task', 'pending', 0, 0)`,
    ).run(wyobiProject);

    // Caller is bound to org_personal — a DIFFERENT org than the project's.
    actions = buildActions({ db, envOrgId: "org_personal", serverUrl: "http://localhost:3777", apiKey: "k" });
  });

  afterEach(() => db.close());

  it("strategy_tree returns the Wyobi project's tree despite an org_personal binding", async () => {
    const res = await dispatch(actions, "strategy_tree", undefined, { projectId: wyobiProject, full: true });
    expect(res.text).toContain("Wyobi-only task");
    expect(res.text).not.toMatch(/No strategy tree/i);
  });

  it("strategy_next finds the Wyobi project's actionable task despite an org_personal binding", async () => {
    const res = await dispatch(actions, "strategy_next", undefined, { projectId: wyobiProject });
    expect(res.text).toContain("Wyobi-only task");
  });

  it("gives an honest message for a genuinely empty project (not a misleading 'no actionable')", async () => {
    db.prepare(
      `INSERT INTO projects (id, org_id, name, path, account_id, token_budget, autonomy_level, status)
       VALUES ('proj_empty', 'org_personal', 'Empty', '/tmp/empty', 'acc_personal_1', 500000, 'supervised', 'idle')`,
    ).run();
    const res = await dispatch(actions, "strategy_tree", undefined, { projectId: "proj_empty", full: true });
    expect(res.text).toMatch(/no strategy tree \(0 nodes\)/i);
  });

  it("reports an unknown project id clearly", async () => {
    const res = await dispatch(actions, "strategy_next", undefined, { projectId: "does-not-exist" });
    expect(res.text).toMatch(/unknown project/i);
  });
});
