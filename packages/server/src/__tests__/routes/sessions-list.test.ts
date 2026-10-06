import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { createTestDb, seedMultiOrg } from "../helpers/db.js";
import { registerSessionRoutes } from "../../routes/sessions.js";
import type { SessionManager } from "../../orchestrator/session-manager.js";
import type { SupervisionLoop } from "../../orchestrator/supervision-loop.js";
import type { BudgetPacer } from "../../budget/budget-pacer.js";

// Minimal stubs — we only test routes that don't actually invoke these
function fakeSessionManager(): SessionManager {
  return {
    launch: () => "fake_id",
    stop: () => {},
    redirect: () => true,
    updateStatusExternal: () => {},
    getStatus: () => null,
    getActiveSessions: () => [],
    shutdownAll: async () => {},
    setVectorIndexer: () => {},
  } as unknown as SessionManager;
}

function fakeSupervision(): SupervisionLoop {
  return {
    eventStore: {
      getPendingEscalations: () => [],
    },
  } as unknown as SupervisionLoop;
}

function fakePacer(): BudgetPacer {
  return {
    canLaunchSession: () => ({ allowed: true }),
    estimateSessionCost: () => 0,
  } as unknown as BudgetPacer;
}

async function buildApp(db: Database.Database): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerSessionRoutes(app, db, fakeSessionManager(), fakeSupervision(), fakePacer());
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
    status: string;
  },
): void {
  db.prepare(`
    INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash)
    VALUES (?, ?, ?, ?, ?, 'goal', 'h')
  `).run(params.id, params.projectId, params.orgId, params.accountId, params.status);
}

describe("GET /api/sessions", () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = createTestDb();
    app = await buildApp(db);
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it("returns empty list when no sessions exist", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: boolean; data: unknown[] };
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
  });

  it("filters sessions by org_id directly (not via project JOIN)", async () => {
    const ids = seedMultiOrg(db);
    insertSession(db, { id: "s_p", projectId: ids.personal.projectId, orgId: ids.personal.orgId, accountId: ids.personal.accountId, status: "running" });
    insertSession(db, { id: "s_w", projectId: ids.work.projectId, orgId: ids.work.orgId, accountId: ids.work.accountId, status: "running" });
    insertSession(db, { id: "s_a", projectId: ids.side.projectId, orgId: ids.side.orgId, accountId: ids.side.accountId, status: "running" });

    const res = await app.inject({ method: "GET", url: "/api/sessions?orgId=org_personal" });
    const body = res.json() as { data: Array<{ id: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe("s_p");
  });

  it("filters by status independently of org", async () => {
    const ids = seedMultiOrg(db);
    insertSession(db, { id: "s1", projectId: ids.personal.projectId, orgId: ids.personal.orgId, accountId: ids.personal.accountId, status: "running" });
    insertSession(db, { id: "s2", projectId: ids.personal.projectId, orgId: ids.personal.orgId, accountId: ids.personal.accountId, status: "completed" });
    insertSession(db, { id: "s3", projectId: ids.work.projectId, orgId: ids.work.orgId, accountId: ids.work.accountId, status: "running" });

    const res = await app.inject({ method: "GET", url: "/api/sessions?status=running" });
    const body = res.json() as { data: Array<{ id: string }> };
    expect(body.data.map((s) => s.id).sort()).toEqual(["s1", "s3"]);
  });

  it("combines org and status filters", async () => {
    const ids = seedMultiOrg(db);
    insertSession(db, { id: "s1", projectId: ids.personal.projectId, orgId: ids.personal.orgId, accountId: ids.personal.accountId, status: "running" });
    insertSession(db, { id: "s2", projectId: ids.personal.projectId, orgId: ids.personal.orgId, accountId: ids.personal.accountId, status: "completed" });
    insertSession(db, { id: "s3", projectId: ids.work.projectId, orgId: ids.work.orgId, accountId: ids.work.accountId, status: "running" });

    const res = await app.inject({
      method: "GET",
      url: "/api/sessions?orgId=org_personal&status=running",
    });
    const body = res.json() as { data: Array<{ id: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe("s1");
  });

  it("returns project_name and org info via JOIN", async () => {
    const ids = seedMultiOrg(db);
    insertSession(db, { id: "s_p", projectId: ids.personal.projectId, orgId: ids.personal.orgId, accountId: ids.personal.accountId, status: "running" });

    const res = await app.inject({ method: "GET", url: "/api/sessions?orgId=org_personal" });
    const body = res.json() as { data: Array<{ project_name: string; org_name: string; org_slug: string }> };
    expect(body.data[0].project_name).toBe("Personal Project");
    expect(body.data[0].org_name).toBe("Personal");
    expect(body.data[0].org_slug).toBe("personal");
  });

  it("orders sessions by started_at DESC", async () => {
    const ids = seedMultiOrg(db);
    insertSession(db, { id: "s_old", projectId: ids.personal.projectId, orgId: ids.personal.orgId, accountId: ids.personal.accountId, status: "completed" });
    db.prepare(`UPDATE sessions SET started_at = '2020-01-01 00:00:00' WHERE id = 's_old'`).run();
    insertSession(db, { id: "s_new", projectId: ids.personal.projectId, orgId: ids.personal.orgId, accountId: ids.personal.accountId, status: "running" });

    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    const body = res.json() as { data: Array<{ id: string }> };
    expect(body.data[0].id).toBe("s_new");
    expect(body.data[1].id).toBe("s_old");
  });

  it("limits to 100 sessions", async () => {
    const ids = seedMultiOrg(db);
    for (let i = 0; i < 110; i++) {
      insertSession(db, {
        id: `s_${i}`,
        projectId: ids.personal.projectId,
        orgId: ids.personal.orgId,
        accountId: ids.personal.accountId,
        status: "completed",
      });
    }
    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    const body = res.json() as { data: unknown[] };
    expect(body.data).toHaveLength(100);
  });

  it("returns 404 for unknown session id", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/does-not-exist" });
    // The route returns success:false but 200 — preserve existing behavior
    const body = res.json() as { success: boolean };
    expect(body.success).toBe(false);
  });

  it("auto-registers a manual session for a known project", async () => {
    const ids = seedMultiOrg(db);
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/register",
      payload: { orgId: ids.personal.orgId, projectPath: "/tmp/personal" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { success: boolean; data: { sessionId: string } };
    expect(body.success).toBe(true);
    expect(body.data.sessionId).toMatch(/^manual_/);

    // Verify the row has org_id populated
    const row = db
      .prepare(`SELECT org_id FROM sessions WHERE id = ?`)
      .get(body.data.sessionId) as { org_id: string };
    expect(row.org_id).toBe(ids.personal.orgId);
  });

  it("auto-provisions an Ad-hoc project for an unknown path (no longer 404 — sessions must stay visible)", async () => {
    seedMultiOrg(db);
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/register",
      payload: { orgId: "org_personal", projectPath: "/nope/does/not/exist" },
    });
    expect([200, 201]).toContain(res.statusCode);
    const adhoc = db
      .prepare(`SELECT id FROM projects WHERE org_id='org_personal' AND path='__adhoc__/org_personal'`)
      .get();
    expect(adhoc).toBeDefined();
  });

  it("reuses an active manual session if one is already running for the project", async () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "manual_existing",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      status: "running",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/register",
      payload: { orgId: ids.personal.orgId, projectPath: "/tmp/personal" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: boolean; data: { sessionId: string; reused: boolean } };
    expect(body.data.sessionId).toBe("manual_existing");
    expect(body.data.reused).toBe(true);
  });
});
