import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { createTestDb, seedMultiOrg } from "../helpers/db.js";
import { registerAlertRoutes } from "../../routes/alerts.js";

async function buildApp(db: Database.Database): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerAlertRoutes(app, db);
  await app.ready();
  return app;
}

function insertAlert(
  db: Database.Database,
  params: {
    orgId: string;
    projectId?: string;
    type?: string;
    severity?: "info" | "warning" | "critical";
    message?: string;
    acknowledged?: 0 | 1;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO alerts (org_id, project_id, type, severity, message, acknowledged)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.orgId,
      params.projectId ?? null,
      params.type ?? "test",
      params.severity ?? "info",
      params.message ?? "test alert",
      params.acknowledged ?? 0,
    );
  return Number(result.lastInsertRowid);
}

describe("GET /api/alerts", () => {
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

  it("returns empty list when no alerts exist", async () => {
    const res = await app.inject({ method: "GET", url: "/api/alerts" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { success: boolean; data: unknown[] };
    expect(body.data).toEqual([]);
  });

  it("filters alerts by orgId", async () => {
    const ids = seedMultiOrg(db);
    insertAlert(db, { orgId: ids.personal.orgId, message: "p1" });
    insertAlert(db, { orgId: ids.work.orgId, message: "w1" });

    const res = await app.inject({ method: "GET", url: "/api/alerts?orgId=org_personal" });
    const body = res.json() as { data: Array<{ message: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].message).toBe("p1");
  });

  it("filters by unackedOnly=true", async () => {
    const ids = seedMultiOrg(db);
    insertAlert(db, { orgId: ids.personal.orgId, message: "fresh" });
    insertAlert(db, { orgId: ids.personal.orgId, message: "old", acknowledged: 1 });

    const res = await app.inject({ method: "GET", url: "/api/alerts?unackedOnly=true" });
    const body = res.json() as { data: Array<{ message: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].message).toBe("fresh");
  });

  it("respects custom limit param", async () => {
    const ids = seedMultiOrg(db);
    for (let i = 0; i < 60; i++) {
      insertAlert(db, { orgId: ids.personal.orgId, message: `a${i}` });
    }
    const res = await app.inject({ method: "GET", url: "/api/alerts?limit=10" });
    const body = res.json() as { data: unknown[] };
    expect(body.data).toHaveLength(10);
  });

  it("defaults limit to 50", async () => {
    const ids = seedMultiOrg(db);
    for (let i = 0; i < 60; i++) {
      insertAlert(db, { orgId: ids.personal.orgId, message: `a${i}` });
    }
    const res = await app.inject({ method: "GET", url: "/api/alerts" });
    const body = res.json() as { data: unknown[] };
    expect(body.data).toHaveLength(50);
  });

  it("orders by created_at DESC", async () => {
    const ids = seedMultiOrg(db);
    const a = insertAlert(db, { orgId: ids.personal.orgId, message: "first" });
    const b = insertAlert(db, { orgId: ids.personal.orgId, message: "second" });
    const c = insertAlert(db, { orgId: ids.personal.orgId, message: "third" });
    // Same-second creation has identical timestamps in SQLite — set them
    // explicitly so ORDER BY created_at DESC has something to rank by.
    db.prepare(`UPDATE alerts SET created_at = ? WHERE id = ?`).run("2026-01-01 00:00:00", a);
    db.prepare(`UPDATE alerts SET created_at = ? WHERE id = ?`).run("2026-01-02 00:00:00", b);
    db.prepare(`UPDATE alerts SET created_at = ? WHERE id = ?`).run("2026-01-03 00:00:00", c);

    const res = await app.inject({ method: "GET", url: "/api/alerts" });
    const body = res.json() as { data: Array<{ message: string }> };
    expect(body.data[0].message).toBe("third");
  });

  it("includes org_name and project_name via joins", async () => {
    const ids = seedMultiOrg(db);
    insertAlert(db, {
      orgId: ids.personal.orgId,
      projectId: ids.personal.projectId,
      message: "tagged",
    });
    const res = await app.inject({ method: "GET", url: "/api/alerts" });
    const body = res.json() as { data: Array<{ org_name: string; project_name: string }> };
    expect(body.data[0].org_name).toBe("Personal");
    expect(body.data[0].project_name).toBe("Personal Project");
  });
});

describe("POST /api/alerts/:id/ack", () => {
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

  it("returns 404 for unknown alert id", async () => {
    const res = await app.inject({ method: "POST", url: "/api/alerts/99999/ack" });
    expect(res.statusCode).toBe(404);
  });

  it("acknowledges an alert and persists the flag", async () => {
    const ids = seedMultiOrg(db);
    const alertId = insertAlert(db, { orgId: ids.personal.orgId });

    const res = await app.inject({ method: "POST", url: `/api/alerts/${alertId}/ack` });
    expect(res.statusCode).toBe(200);

    const row = db
      .prepare(`SELECT acknowledged FROM alerts WHERE id = ?`)
      .get(alertId) as { acknowledged: number };
    expect(row.acknowledged).toBe(1);
  });
});

describe("POST /api/alerts/ack-all", () => {
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

  it("acks all unacked alerts when no orgId given", async () => {
    const ids = seedMultiOrg(db);
    insertAlert(db, { orgId: ids.personal.orgId });
    insertAlert(db, { orgId: ids.work.orgId });
    insertAlert(db, { orgId: ids.side.orgId });

    const res = await app.inject({ method: "POST", url: "/api/alerts/ack-all" });
    expect(res.statusCode).toBe(200);

    const remaining = db
      .prepare(`SELECT COUNT(*) as n FROM alerts WHERE acknowledged = 0`)
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("only acks for the given org", async () => {
    const ids = seedMultiOrg(db);
    insertAlert(db, { orgId: ids.personal.orgId });
    insertAlert(db, { orgId: ids.work.orgId });

    const res = await app.inject({ method: "POST", url: "/api/alerts/ack-all?orgId=org_personal" });
    expect(res.statusCode).toBe(200);

    const acked = db
      .prepare(`SELECT COUNT(*) as n FROM alerts WHERE acknowledged = 1 AND org_id = ?`)
      .get("org_personal") as { n: number };
    const unacked = db
      .prepare(`SELECT COUNT(*) as n FROM alerts WHERE acknowledged = 0 AND org_id = ?`)
      .get("org_work") as { n: number };
    expect(acked.n).toBe(1);
    expect(unacked.n).toBe(1);
  });
});
