import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { createTestDb, seedMultiOrg } from "../helpers/db.js";

interface HealthChecks {
  db_read: { ok: boolean; detail?: string };
  db_pragma: { ok: boolean; detail?: string };
  stuck_starting_sessions: { ok: boolean; detail?: string };
}
interface DeepHealthResponse {
  status: "ok" | "degraded";
  timestamp: string;
  activeSessions: number;
  uptimeSeconds: number;
  memoryMB: number;
  checks: HealthChecks;
}

/**
 * Inline a minimal version of the health/deep route — keeps the test focused
 * on the behavior we ship without booting the full server with all routes.
 * If the route logic changes, mirror it here AND update the production handler.
 */
async function buildApp(db: Database.Database, activeSessionsCount = 0): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.get("/health/deep", async () => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    try {
      const r = db.prepare(`SELECT 1 as one`).get() as { one: number };
      checks.db_read = { ok: r.one === 1 };
    } catch (e) {
      checks.db_read = { ok: false, detail: (e as Error).message };
    }
    try {
      db.pragma("user_version");
      checks.db_pragma = { ok: true };
    } catch (e) {
      checks.db_pragma = { ok: false, detail: (e as Error).message };
    }
    const stuck = db.prepare(`
      SELECT COUNT(*) as n FROM sessions
      WHERE status = 'starting' AND started_at < datetime('now', '-15 minutes')
    `).get() as { n: number };
    checks.stuck_starting_sessions = {
      ok: stuck.n === 0,
      detail: stuck.n > 0 ? `${stuck.n} session(s) stuck in starting` : undefined,
    };
    const allOk = Object.values(checks).every((c) => c.ok);
    return {
      status: allOk ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      activeSessions: activeSessionsCount,
      uptimeSeconds: Math.floor(process.uptime()),
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      checks,
    };
  });
  await app.ready();
  return app;
}

describe("GET /health/deep", () => {
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

  it("returns ok when db reads work and no stuck sessions", async () => {
    const res = await app.inject({ method: "GET", url: "/health/deep" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as DeepHealthResponse;
    expect(body.status).toBe("ok");
    expect(body.checks.db_read.ok).toBe(true);
    expect(body.checks.db_pragma.ok).toBe(true);
    expect(body.checks.stuck_starting_sessions.ok).toBe(true);
  });

  it("returns uptime and memory metrics", async () => {
    const res = await app.inject({ method: "GET", url: "/health/deep" });
    const body = res.json() as DeepHealthResponse;
    expect(typeof body.uptimeSeconds).toBe("number");
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(typeof body.memoryMB).toBe("number");
    expect(body.memoryMB).toBeGreaterThan(0);
  });

  it("flags degraded when sessions are stuck in 'starting' for >15min", async () => {
    const ids = seedMultiOrg(db);
    db.prepare(`
      INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash, started_at)
      VALUES ('stuck', ?, ?, ?, 'starting', 'g', 'h', '2024-01-01 00:00:00')
    `).run(ids.personal.projectId, ids.personal.orgId, ids.personal.accountId);

    const res = await app.inject({ method: "GET", url: "/health/deep" });
    const body = res.json() as DeepHealthResponse;
    expect(body.status).toBe("degraded");
    expect(body.checks.stuck_starting_sessions.ok).toBe(false);
    expect(body.checks.stuck_starting_sessions.detail).toContain("1 session");
  });

  it("does NOT flag degraded for fresh 'starting' sessions", async () => {
    const ids = seedMultiOrg(db);
    db.prepare(`
      INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash)
      VALUES ('fresh', ?, ?, ?, 'starting', 'g', 'h')
    `).run(ids.personal.projectId, ids.personal.orgId, ids.personal.accountId);

    const res = await app.inject({ method: "GET", url: "/health/deep" });
    const body = res.json() as DeepHealthResponse;
    expect(body.status).toBe("ok");
  });
});
