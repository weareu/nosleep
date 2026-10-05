import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { createTestDb, seedMultiOrg } from "../helpers/db.js";
import { registerOrgRoutes } from "../../routes/orgs.js";

async function buildApp(db: Database.Database): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerOrgRoutes(app, db);
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

describe("GET /api/orgs", () => {
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

  it("returns the three seeded organizations", async () => {
    const res = await app.inject({ method: "GET", url: "/api/orgs" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: boolean; data: Array<{ id: string; slug: string }> };
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(3);
    const slugs = body.data.map((o) => o.slug).sort();
    expect(slugs).toEqual(["apply", "personal", "wyobi"]);
  });

  it("counts active sessions per org via sessions.org_id (no JOIN)", async () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "s1",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      status: "running",
    });
    insertSession(db, {
      id: "s2",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      status: "idle",
    });
    insertSession(db, {
      id: "s3",
      projectId: ids.wyobi.projectId,
      orgId: ids.wyobi.orgId,
      accountId: ids.wyobi.accountId,
      status: "running",
    });
    insertSession(db, {
      id: "s_done",
      projectId: ids.apply.projectId,
      orgId: ids.apply.orgId,
      accountId: ids.apply.accountId,
      status: "completed",
    });

    const res = await app.inject({ method: "GET", url: "/api/orgs" });
    const body = res.json() as { data: Array<{ id: string; activeSessions: number; projectCount: number }> };

    const personal = body.data.find((o) => o.id === "org_personal")!;
    const wyobi = body.data.find((o) => o.id === "org_wyobi")!;
    const apply = body.data.find((o) => o.id === "org_apply")!;

    expect(personal.activeSessions).toBe(2); // running + idle
    expect(wyobi.activeSessions).toBe(1); // running
    expect(apply.activeSessions).toBe(0); // completed doesn't count
  });

  it("counts unacknowledged alerts per org", async () => {
    const ids = seedMultiOrg(db);
    db.prepare(`INSERT INTO alerts (org_id, type, severity, message, acknowledged) VALUES (?, ?, ?, ?, ?)`).run(
      ids.personal.orgId,
      "drift",
      "warning",
      "drift detected",
      0,
    );
    db.prepare(`INSERT INTO alerts (org_id, type, severity, message, acknowledged) VALUES (?, ?, ?, ?, ?)`).run(
      ids.personal.orgId,
      "drift",
      "warning",
      "another",
      0,
    );
    db.prepare(`INSERT INTO alerts (org_id, type, severity, message, acknowledged) VALUES (?, ?, ?, ?, ?)`).run(
      ids.personal.orgId,
      "drift",
      "warning",
      "old",
      1,
    );

    const res = await app.inject({ method: "GET", url: "/api/orgs" });
    const body = res.json() as { data: Array<{ id: string; unackedAlerts: number }> };
    const personal = body.data.find((o) => o.id === "org_personal")!;
    expect(personal.unackedAlerts).toBe(2);
  });

  it("returns zero counts when no projects/sessions exist", async () => {
    const res = await app.inject({ method: "GET", url: "/api/orgs" });
    const body = res.json() as { data: Array<{ activeSessions: number; projectCount: number; unackedAlerts: number }> };
    for (const org of body.data) {
      expect(org.activeSessions).toBe(0);
      expect(org.projectCount).toBe(0);
      expect(org.unackedAlerts).toBe(0);
    }
  });
});
