/**
 * Health endpoints — `/health` is the cheap liveness probe, `/health/deep`
 * exercises the DB and surfaces stuck-session counts for the watchdog.
 */

import type { FastifyInstance } from "fastify";
import type { Services } from "../services/init.js";

export function registerHealthRoutes(fastify: FastifyInstance, services: Services): void {
  const { db, sessionManager } = services;

  fastify.get("/health", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
    activeSessions: sessionManager.getActiveSessions().length,
  }));

  fastify.get("/health/deep", async () => {
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
      activeSessions: sessionManager.getActiveSessions().length,
      uptimeSeconds: Math.floor(process.uptime()),
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      checks,
    };
  });
}
