import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { createTestDb, seedMultiOrg } from "../helpers/db.js";
import { registerSessionRoutes } from "../../routes/sessions.js";
import type { SessionManager } from "../../orchestrator/session-manager.js";
import type { SupervisionLoop } from "../../orchestrator/supervision-loop.js";
import type { BudgetPacer } from "../../budget/budget-pacer.js";
import { nanoid } from "nanoid";

interface FakeManager {
  launches: Array<{
    projectId: string;
    orgId: string;
    accountId: string;
    goal: string;
    acceptanceCriteria: readonly string[];
  }>;
  manager: SessionManager;
}

function makeFakeManager(db?: Database.Database): FakeManager {
  const launches: FakeManager["launches"] = [];
  const manager = {
    launch: vi.fn((req: {
      projectId: string;
      orgId: string;
      accountId: string;
      goal: string;
      acceptanceCriteria: readonly string[];
    }) => {
      launches.push(req);
      const childId = `child_${nanoid(6)}`;
      // Mirror real sessionManager.launch which inserts the session row
      if (db) {
        db.prepare(`
          INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash)
          VALUES (?, ?, ?, ?, 'starting', ?, 'h')
        `).run(childId, req.projectId, req.orgId, req.accountId, req.goal);
      }
      return childId;
    }),
    stop: vi.fn(),
    redirect: vi.fn(() => true),
    updateStatusExternal: vi.fn(),
    getStatus: vi.fn(() => null),
    getActiveSessions: vi.fn(() => []),
    shutdownAll: vi.fn(async () => {}),
    setVectorIndexer: vi.fn(),
  } as unknown as SessionManager;
  return { launches, manager };
}

const fakeSupervision = {
  eventStore: { getPendingEscalations: () => [] },
} as unknown as SupervisionLoop;

const fakePacer = {
  canLaunchSession: () => ({ allowed: true }),
  estimateSessionCost: () => 0,
} as unknown as BudgetPacer;

async function buildApp(db: Database.Database, mgr: SessionManager): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerSessionRoutes(app, db, mgr, fakeSupervision, fakePacer);
  await app.ready();
  return app;
}

function insertSession(
  db: Database.Database,
  params: {
    id: string;
    projectId: string;
    orgId: string;
    accountId: string;
    status?: string;
    parentId?: string | null;
    failureMode?: string | null;
  },
): void {
  db.prepare(`
    INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash, parent_session_id, failure_mode)
    VALUES (?, ?, ?, ?, ?, 'do the thing', 'h', ?, ?)
  `).run(
    params.id,
    params.projectId,
    params.orgId,
    params.accountId,
    params.status ?? "failed",
    params.parentId ?? null,
    params.failureMode ?? null,
  );
}

function insertGoal(db: Database.Database, sessionId: string, projectId: string, criteria: string[]): void {
  db.prepare(`
    INSERT INTO goals (id, session_id, project_id, objective, acceptance_criteria)
    VALUES (?, ?, ?, 'objective', ?)
  `).run(
    "g_" + sessionId,
    sessionId,
    projectId,
    JSON.stringify(criteria.map((c) => ({ description: c, met: false }))),
  );
}

describe("POST /api/sessions/:id/fork", () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let fake: FakeManager;

  beforeEach(async () => {
    db = createTestDb();
    fake = makeFakeManager(db);
    app = await buildApp(db, fake.manager);
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("returns 404 when parent session doesn't exist", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/nope/fork",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it("forks a failed session, returns child id, and links via parent_session_id", async () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "parent1",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      status: "failed",
    });
    insertGoal(db, "parent1", ids.personal.projectId, ["test passes", "no errors"]);

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/parent1/fork",
      payload: { failureMode: "validation_failed", failureSummary: "stub left in code" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { data: { parentSessionId: string; childSessionId: string; goalLength: number } };
    expect(body.data.parentSessionId).toBe("parent1");
    expect(body.data.childSessionId).toMatch(/^child_/);

    // Manager called with augmented goal
    expect(fake.launches).toHaveLength(1);
    const launch = fake.launches[0];
    expect(launch.goal).toContain("RETRY — PREVIOUS ATTEMPT FAILED");
    expect(launch.goal).toContain("validation_failed");
    expect(launch.goal).toContain("stub left in code");
    expect(launch.goal).toContain("ORIGINAL GOAL");
    expect(launch.acceptanceCriteria).toContain("test passes");
    expect(launch.acceptanceCriteria).toContain("no errors");

    // parent_session_id wired on child
    const child = db.prepare(`SELECT parent_session_id FROM sessions WHERE id = ?`).get(body.data.childSessionId) as { parent_session_id: string };
    expect(child.parent_session_id).toBe("parent1");

    // failure context persisted on parent
    const parent = db.prepare(`SELECT failure_mode, failure_summary FROM sessions WHERE id = ?`).get("parent1") as { failure_mode: string; failure_summary: string };
    expect(parent.failure_mode).toBe("validation_failed");
    expect(parent.failure_summary).toBe("stub left in code");
  });

  it("works without explicit failure context (just retries with original goal)", async () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "parent2",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/parent2/fork",
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const launch = fake.launches[0];
    expect(launch.goal).toContain("ORIGINAL GOAL");
    expect(launch.goal).toContain("do the thing");
  });

  it("rejects oversized failure summary", async () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "parent3",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
    });
    const huge = "x".repeat(5000);
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/parent3/fork",
      payload: { failureSummary: huge },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 503 if budget pacer rejects the new launch", async () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "parent4",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
    });
    // Make the launch throw
    (fake.manager.launch as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("budget pacer rejected");
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/parent4/fork",
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ success: false, error: expect.stringContaining("budget pacer") });
  });
});

describe("GET /api/sessions/:id/chain", () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = createTestDb();
    const fake = makeFakeManager(db);
    app = await buildApp(db, fake.manager);
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("returns single-element chain for a session with no parent or children", async () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "solo",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
    });

    const res = await app.inject({ method: "GET", url: "/api/sessions/solo/chain" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { ancestors: Array<{ id: string }>; descendants: Array<{ id: string }> };
    };
    expect(body.data.ancestors.map((a) => a.id)).toEqual(["solo"]);
    expect(body.data.descendants).toHaveLength(0);
  });

  it("walks ancestors back to root", async () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "gp",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
    });
    insertSession(db, {
      id: "p",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      parentId: "gp",
    });
    insertSession(db, {
      id: "c",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      parentId: "p",
    });

    const res = await app.inject({ method: "GET", url: "/api/sessions/c/chain" });
    const body = res.json() as { data: { ancestors: Array<{ id: string }>; descendants: Array<{ id: string }> } };
    expect(body.data.ancestors.map((a) => a.id)).toEqual(["gp", "p", "c"]);
    expect(body.data.descendants).toHaveLength(0);
  });

  it("collects descendants in BFS order", async () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "root",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
    });
    insertSession(db, {
      id: "c1",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      parentId: "root",
    });
    insertSession(db, {
      id: "c2",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      parentId: "root",
    });
    insertSession(db, {
      id: "gc",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      parentId: "c1",
    });

    const res = await app.inject({ method: "GET", url: "/api/sessions/root/chain" });
    const body = res.json() as { data: { descendants: Array<{ id: string }> } };
    expect(body.data.descendants).toHaveLength(3);
    const ids_in_order = body.data.descendants.map((d) => d.id);
    // c1 and c2 first (level 1), then gc (level 2)
    expect(ids_in_order.indexOf("gc")).toBeGreaterThan(ids_in_order.indexOf("c1"));
  });

  it("returns failure_mode and failure_summary on each ancestor", async () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "with_failure",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      failureMode: "timeout",
    });

    const res = await app.inject({ method: "GET", url: "/api/sessions/with_failure/chain" });
    const body = res.json() as { data: { ancestors: Array<{ id: string; failure_mode: string | null }> } };
    expect(body.data.ancestors[0].failure_mode).toBe("timeout");
  });
});
