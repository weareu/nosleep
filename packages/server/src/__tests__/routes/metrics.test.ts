import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { createTestDb, seedMultiOrg } from "../helpers/db.js";
import { registerMetricsRoutes } from "../../routes/metrics.js";

async function buildApp(db: Database.Database): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerMetricsRoutes(app, db);
  await app.ready();
  return app;
}

interface MetricsResponse {
  data: {
    windowHours: number;
    orgId: string;
    sessions: { total: number; durationSeconds: { count: number; p50: number; avg: number } };
    tokens: { total: number; velocityPerHour: number };
    drift: { alertCount: number; perSession: number };
    escalations: { alertCount: number; perSession: number };
    validation: Record<string, number>;
  };
}

function insertSession(
  db: Database.Database,
  params: {
    id: string;
    projectId: string;
    orgId: string;
    accountId: string;
    status: string;
    tokensUsed?: number;
    startedAt?: string;
    endedAt?: string | null;
  },
): void {
  db.prepare(`
    INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash, tokens_used, started_at, ended_at)
    VALUES (?, ?, ?, ?, ?, 'g', 'h', ?, ?, ?)
  `).run(
    params.id,
    params.projectId,
    params.orgId,
    params.accountId,
    params.status,
    params.tokensUsed ?? 0,
    params.startedAt ?? new Date().toISOString().replace("T", " ").slice(0, 19),
    params.endedAt ?? null,
  );
}

describe("GET /api/metrics", () => {
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

  it("returns zeroed metrics with no data", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as MetricsResponse;
    expect(body.data.sessions.total).toBe(0);
    expect(body.data.tokens.total).toBe(0);
    expect(body.data.drift.perSession).toBe(0);
    expect(body.data.escalations.perSession).toBe(0);
  });

  it("defaults to 24-hour window, clamps invalid values", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics?windowHours=abc" });
    const body = res.json() as MetricsResponse;
    expect(body.data.windowHours).toBe(24);
  });

  it("clamps windowHours to max of 168 (1 week)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics?windowHours=99999" });
    const body = res.json() as MetricsResponse;
    expect(body.data.windowHours).toBe(168);
  });

  it("clamps windowHours to min of 1", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics?windowHours=-50" });
    const body = res.json() as MetricsResponse;
    expect(body.data.windowHours).toBe(1);
  });

  it("counts sessions and computes p50/p95 duration", async () => {
    const ids = seedMultiOrg(db);
    // 3 completed sessions with known durations: 60, 120, 600 seconds
    const now = new Date();
    const start = new Date(now.getTime() - 3600_000); // 1h ago

    const fmt = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);

    insertSession(db, {
      id: "s1",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      status: "completed",
      startedAt: fmt(start),
      endedAt: fmt(new Date(start.getTime() + 60_000)),
    });
    insertSession(db, {
      id: "s2",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      status: "completed",
      startedAt: fmt(start),
      endedAt: fmt(new Date(start.getTime() + 120_000)),
    });
    insertSession(db, {
      id: "s3",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      status: "completed",
      startedAt: fmt(start),
      endedAt: fmt(new Date(start.getTime() + 600_000)),
    });

    const res = await app.inject({ method: "GET", url: "/api/metrics" });
    const body = res.json() as MetricsResponse;
    expect(body.data.sessions.total).toBe(3);
    expect(body.data.sessions.durationSeconds.count).toBe(3);
    // p50 of [60, 120, 600] should be ~120 (julianday math may round ±1s)
    expect(body.data.sessions.durationSeconds.p50).toBeGreaterThanOrEqual(115);
    expect(body.data.sessions.durationSeconds.p50).toBeLessThanOrEqual(125);
    expect(body.data.sessions.durationSeconds.avg).toBeGreaterThan(0);
  });

  it("filters by orgId", async () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "s_p",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      status: "running",
    });
    insertSession(db, {
      id: "s_w",
      projectId: ids.wyobi.projectId,
      orgId: ids.wyobi.orgId,
      accountId: ids.wyobi.accountId,
      status: "running",
    });

    const res = await app.inject({ method: "GET", url: "/api/metrics?orgId=org_personal" });
    const body = res.json() as MetricsResponse;
    expect(body.data.orgId).toBe("org_personal");
    expect(body.data.sessions.total).toBe(1);
  });

  it("rejects malformed orgId without crashing", async () => {
    const res = await app.inject({ method: "GET", url: "/api/metrics?orgId=DROP TABLE sessions;--" });
    expect(res.statusCode).toBe(200);
    // Whitelist sanitizer turns it into 'org_invalid' which won't match
    const body = res.json() as MetricsResponse;
    expect(body.data.sessions.total).toBe(0);
  });

  it("counts drift alerts per session", async () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "s_d",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      status: "running",
    });
    db.prepare(`INSERT INTO alerts (org_id, session_id, type, severity, message) VALUES (?, ?, 'drift', 'warning', 'd1')`).run(
      ids.personal.orgId,
      "s_d",
    );
    db.prepare(`INSERT INTO alerts (org_id, session_id, type, severity, message) VALUES (?, ?, 'drift', 'warning', 'd2')`).run(
      ids.personal.orgId,
      "s_d",
    );

    const res = await app.inject({ method: "GET", url: "/api/metrics" });
    const body = res.json() as MetricsResponse;
    expect(body.data.drift.alertCount).toBe(2);
    expect(body.data.drift.perSession).toBe(2);
  });

  it("counts escalations as question alerts + critical alerts", async () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "s_e",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      status: "running",
    });
    db.prepare(`INSERT INTO alerts (org_id, type, severity, message) VALUES (?, 'question', 'info', 'q')`).run(ids.personal.orgId);
    db.prepare(`INSERT INTO alerts (org_id, type, severity, message) VALUES (?, 'crash', 'critical', 'c')`).run(ids.personal.orgId);

    const res = await app.inject({ method: "GET", url: "/api/metrics" });
    const body = res.json() as MetricsResponse;
    expect(body.data.escalations.alertCount).toBe(2);
    expect(body.data.escalations.perSession).toBe(2);
  });

  it("returns validation outcomes by verdict", async () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "s_v",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      status: "completed",
    });
    db.prepare(`
      INSERT INTO goals (id, session_id, project_id, objective)
      VALUES ('g1', 's_v', ?, 'test')
    `).run(ids.personal.projectId);
    db.prepare(`INSERT INTO validations (session_id, goal_id, verdict) VALUES ('s_v', 'g1', 'complete')`).run();
    db.prepare(`INSERT INTO validations (session_id, goal_id, verdict) VALUES ('s_v', 'g1', 'incomplete')`).run();
    db.prepare(`INSERT INTO validations (session_id, goal_id, verdict) VALUES ('s_v', 'g1', 'complete')`).run();

    const res = await app.inject({ method: "GET", url: "/api/metrics" });
    const body = res.json() as MetricsResponse;
    expect(body.data.validation.complete).toBe(2);
    expect(body.data.validation.incomplete).toBe(1);
  });
});

describe("GET /api/metrics/by-org", () => {
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

  it("groups session counts and tokens by org", async () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "p1",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      status: "completed",
      tokensUsed: 1000,
    });
    insertSession(db, {
      id: "p2",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      status: "running",
      tokensUsed: 500,
    });
    insertSession(db, {
      id: "w1",
      projectId: ids.wyobi.projectId,
      orgId: ids.wyobi.orgId,
      accountId: ids.wyobi.accountId,
      status: "completed",
      tokensUsed: 2000,
    });

    const res = await app.inject({ method: "GET", url: "/api/metrics/by-org" });
    const body = res.json() as { data: Array<{ org_id: string; session_count: number; token_total: number }> };
    const personal = body.data.find((r) => r.org_id === "org_personal")!;
    const wyobi = body.data.find((r) => r.org_id === "org_wyobi")!;
    expect(personal.session_count).toBe(2);
    expect(personal.token_total).toBe(1500);
    expect(wyobi.session_count).toBe(1);
    expect(wyobi.token_total).toBe(2000);
  });
});
