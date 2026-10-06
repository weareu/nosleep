import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import {
  getStrategyNode,
  getStrategyNodeInOrg,
  listProjectStrategy,
  listProjectStrategyByDepth,
  getStrategyChildren,
  getStrategyPath,
  getNextSortOrder,
  getSessionOrg,
  getSessionProject,
  sessionInOrg,
  listSessionDriftAlerts,
  listOrgAlerts,
  acknowledgeAlert,
  acknowledgeAllOrgAlerts,
  getSessionBudget,
} from "@nosleep/shared";
import { createTestDb, seedMultiOrg } from "../helpers/db.js";

function insertNode(
  db: Database.Database,
  params: {
    id: string;
    projectId: string;
    orgId: string;
    parentId?: string | null;
    title: string;
    type?: string;
    sortOrder?: number;
    priority?: number;
    depth?: number;
  },
): void {
  db.prepare(`
    INSERT INTO strategy_nodes (id, project_id, org_id, parent_id, type, title, depth, sort_order, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.id,
    params.projectId,
    params.orgId,
    params.parentId ?? null,
    params.type ?? "task",
    params.title,
    params.depth ?? 0,
    params.sortOrder ?? 0,
    params.priority ?? 3,
  );
}

function insertSession(
  db: Database.Database,
  params: { id: string; projectId: string; orgId: string; accountId: string },
): void {
  db.prepare(`
    INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash)
    VALUES (?, ?, ?, ?, 'running', 'g', 'h')
  `).run(params.id, params.projectId, params.orgId, params.accountId);
}

function insertAlert(
  db: Database.Database,
  params: {
    orgId: string;
    sessionId?: string;
    type?: string;
    severity?: string;
    message?: string;
    acknowledged?: number;
  },
): number {
  const result = db.prepare(`
    INSERT INTO alerts (org_id, session_id, type, severity, message, acknowledged)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    params.orgId,
    params.sessionId ?? null,
    params.type ?? "test",
    params.severity ?? "info",
    params.message ?? "msg",
    params.acknowledged ?? 0,
  );
  return Number(result.lastInsertRowid);
}

describe("Strategy node queries", () => {
  let db: Database.Database;
  let projectId: string;
  let orgId: string;

  beforeEach(() => {
    db = createTestDb();
    const ids = seedMultiOrg(db);
    projectId = ids.personal.projectId;
    orgId = ids.personal.orgId;
  });

  afterEach(() => db.close());

  it("getStrategyNode returns row by id", () => {
    insertNode(db, { id: "n1", projectId, orgId, title: "T" });
    const node = getStrategyNode(db, "n1");
    expect(node?.title).toBe("T");
  });

  it("getStrategyNode returns undefined for unknown id", () => {
    expect(getStrategyNode(db, "missing")).toBeUndefined();
  });

  it("getStrategyNodeInOrg filters by org_id", () => {
    insertNode(db, { id: "n1", projectId, orgId, title: "T" });
    expect(getStrategyNodeInOrg(db, "n1", orgId)?.title).toBe("T");
    expect(getStrategyNodeInOrg(db, "n1", "org_work")).toBeUndefined();
  });

  it("listProjectStrategy returns nodes ordered by priority then sort_order", () => {
    insertNode(db, { id: "low", projectId, orgId, title: "Low", priority: 4, sortOrder: 1 });
    insertNode(db, { id: "crit", projectId, orgId, title: "Crit", priority: 1, sortOrder: 2 });
    insertNode(db, { id: "norm", projectId, orgId, title: "Norm", priority: 3, sortOrder: 0 });

    const rows = listProjectStrategy(db, projectId, orgId);
    expect(rows.map((r) => r.id)).toEqual(["crit", "norm", "low"]);
  });

  it("listProjectStrategyByDepth respects depth in ordering", () => {
    insertNode(db, { id: "child", projectId, orgId, title: "Child", depth: 1, sortOrder: 0 });
    insertNode(db, { id: "root", projectId, orgId, title: "Root", depth: 0, sortOrder: 0 });

    const rows = listProjectStrategyByDepth(db, projectId, orgId);
    expect(rows[0].id).toBe("root");
    expect(rows[1].id).toBe("child");
  });

  it("getStrategyChildren returns only direct children", () => {
    insertNode(db, { id: "p", projectId, orgId, title: "Parent" });
    insertNode(db, { id: "c1", projectId, orgId, parentId: "p", title: "C1" });
    insertNode(db, { id: "c2", projectId, orgId, parentId: "p", title: "C2" });
    insertNode(db, { id: "gc", projectId, orgId, parentId: "c1", title: "Grandchild" });

    const children = getStrategyChildren(db, "p");
    expect(children.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
  });

  it("getStrategyPath walks ancestors back to root", () => {
    insertNode(db, { id: "root", projectId, orgId, title: "Root" });
    insertNode(db, { id: "mid", projectId, orgId, parentId: "root", title: "Mid" });
    insertNode(db, { id: "leaf", projectId, orgId, parentId: "mid", title: "Leaf" });

    expect(getStrategyPath(db, "leaf")).toEqual(["Root", "Mid", "Leaf"]);
  });

  it("getStrategyPath returns single element for root node", () => {
    insertNode(db, { id: "solo", projectId, orgId, title: "Solo" });
    expect(getStrategyPath(db, "solo")).toEqual(["Solo"]);
  });

  it("getStrategyPath returns empty for unknown node", () => {
    expect(getStrategyPath(db, "nope")).toEqual([]);
  });

  it("getNextSortOrder returns 0 for parent with no children", () => {
    insertNode(db, { id: "p", projectId, orgId, title: "P" });
    expect(getNextSortOrder(db, "p")).toBe(0);
  });

  it("getNextSortOrder returns max + 1", () => {
    insertNode(db, { id: "p", projectId, orgId, title: "P" });
    insertNode(db, { id: "c1", projectId, orgId, parentId: "p", title: "C", sortOrder: 5 });
    insertNode(db, { id: "c2", projectId, orgId, parentId: "p", title: "C", sortOrder: 12 });
    expect(getNextSortOrder(db, "p")).toBe(13);
  });
});

describe("Session queries", () => {
  let db: Database.Database;
  let projectId: string;
  let orgId: string;
  let accountId: string;

  beforeEach(() => {
    db = createTestDb();
    const ids = seedMultiOrg(db);
    projectId = ids.personal.projectId;
    orgId = ids.personal.orgId;
    accountId = ids.personal.accountId;
    insertSession(db, { id: "s1", projectId, orgId, accountId });
  });

  afterEach(() => db.close());

  it("getSessionOrg returns org_id", () => {
    expect(getSessionOrg(db, "s1")).toBe(orgId);
  });

  it("getSessionOrg returns undefined for unknown sessionId", () => {
    expect(getSessionOrg(db, "missing")).toBeUndefined();
  });

  it("getSessionProject returns project_id", () => {
    expect(getSessionProject(db, "s1")).toBe(projectId);
  });

  it("sessionInOrg true when session is in given org", () => {
    expect(sessionInOrg(db, "s1", orgId)).toBe(true);
  });

  it("sessionInOrg false when session is in a different org", () => {
    expect(sessionInOrg(db, "s1", "org_work")).toBe(false);
  });
});

describe("Alert queries", () => {
  let db: Database.Database;
  let orgId: string;
  let accountId: string;
  let projectId: string;

  beforeEach(() => {
    db = createTestDb();
    const ids = seedMultiOrg(db);
    projectId = ids.personal.projectId;
    orgId = ids.personal.orgId;
    accountId = ids.personal.accountId;
    insertSession(db, { id: "s1", projectId, orgId, accountId });
  });

  afterEach(() => db.close());

  it("listSessionDriftAlerts returns only unacked drift type", () => {
    insertAlert(db, { orgId, sessionId: "s1", type: "drift", message: "drift1" });
    insertAlert(db, { orgId, sessionId: "s1", type: "drift", message: "drift_acked", acknowledged: 1 });
    insertAlert(db, { orgId, sessionId: "s1", type: "other", message: "other" });

    const alerts = listSessionDriftAlerts(db, "s1", orgId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toBe("drift1");
  });

  it("listSessionDriftAlerts respects limit", () => {
    for (let i = 0; i < 10; i++) {
      insertAlert(db, { orgId, sessionId: "s1", type: "drift", message: `d${i}` });
    }
    expect(listSessionDriftAlerts(db, "s1", orgId, 5)).toHaveLength(5);
  });

  it("listOrgAlerts returns only unacked by default", () => {
    insertAlert(db, { orgId, message: "fresh" });
    insertAlert(db, { orgId, message: "old", acknowledged: 1 });

    const rows = listOrgAlerts(db, orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe("fresh");
  });

  it("listOrgAlerts includes acked when option set", () => {
    insertAlert(db, { orgId, message: "fresh" });
    insertAlert(db, { orgId, message: "old", acknowledged: 1 });

    const rows = listOrgAlerts(db, orgId, { includeAcked: true });
    expect(rows).toHaveLength(2);
  });

  it("listOrgAlerts respects limit", () => {
    for (let i = 0; i < 30; i++) insertAlert(db, { orgId, message: `m${i}` });
    expect(listOrgAlerts(db, orgId, { limit: 5 })).toHaveLength(5);
  });

  it("acknowledgeAlert returns true when row updated", () => {
    const id = insertAlert(db, { orgId });
    expect(acknowledgeAlert(db, id, orgId)).toBe(true);
  });

  it("acknowledgeAlert returns false when alert is in different org", () => {
    const id = insertAlert(db, { orgId });
    expect(acknowledgeAlert(db, id, "org_work")).toBe(false);
  });

  it("acknowledgeAlert returns false for unknown id", () => {
    expect(acknowledgeAlert(db, 99999, orgId)).toBe(false);
  });

  it("acknowledgeAllOrgAlerts returns count of changed rows", () => {
    insertAlert(db, { orgId });
    insertAlert(db, { orgId });
    insertAlert(db, { orgId, acknowledged: 1 }); // already acked, should not count
    expect(acknowledgeAllOrgAlerts(db, orgId)).toBe(2);
  });

  it("acknowledgeAllOrgAlerts only affects the given org", () => {
    insertAlert(db, { orgId });
    insertAlert(db, { orgId: "org_work" });
    acknowledgeAllOrgAlerts(db, orgId);
    const workUnacked = db.prepare(`SELECT COUNT(*) as n FROM alerts WHERE org_id = 'org_work' AND acknowledged = 0`).get() as { n: number };
    expect(workUnacked.n).toBe(1);
  });
});

describe("Token budget queries", () => {
  let db: Database.Database;
  let orgId: string;
  let accountId: string;
  let projectId: string;

  beforeEach(() => {
    db = createTestDb();
    const ids = seedMultiOrg(db);
    projectId = ids.personal.projectId;
    orgId = ids.personal.orgId;
    accountId = ids.personal.accountId;
  });

  afterEach(() => db.close());

  it("getSessionBudget joins through projects to return tokens_used + token_budget", () => {
    db.prepare(`
      INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash, tokens_used)
      VALUES ('s1', ?, ?, ?, 'running', 'g', 'h', 50000)
    `).run(projectId, orgId, accountId);

    const result = getSessionBudget(db, "s1", orgId);
    expect(result?.tokens_used).toBe(50000);
    expect(result?.token_budget).toBe(500_000); // default from helpers/db.ts
  });

  it("getSessionBudget returns undefined when session in wrong org", () => {
    db.prepare(`
      INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash)
      VALUES ('s1', ?, ?, ?, 'running', 'g', 'h')
    `).run(projectId, orgId, accountId);
    expect(getSessionBudget(db, "s1", "org_work")).toBeUndefined();
  });
});
