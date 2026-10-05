import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { LIVE_SESSION_STATUSES_SQL } from "@nosleep/shared";

export function registerOrgRoutes(
  fastify: FastifyInstance,
  db: Database.Database,
): void {
  // List all organizations with summary stats
  fastify.get("/api/orgs", async () => {
    const orgs = db.prepare(`SELECT * FROM organizations ORDER BY slug`).all() as Array<{
      id: string; name: string; slug: string; color: string;
    }>;

    // Batch queries instead of N+1 per org
    const projectCounts = new Map(
      (db.prepare(`SELECT org_id, COUNT(*) as count FROM projects GROUP BY org_id`).all() as Array<{ org_id: string; count: number }>)
        .map(r => [r.org_id, r.count])
    );
    const sessionCounts = new Map(
      // Direct sessions.org_id — no JOIN through projects
      (db.prepare(`SELECT org_id, COUNT(*) as count FROM sessions WHERE status IN ${LIVE_SESSION_STATUSES_SQL} GROUP BY org_id`).all() as Array<{ org_id: string; count: number }>)
        .map(r => [r.org_id, r.count])
    );
    const alertCounts = new Map(
      (db.prepare(`SELECT org_id, COUNT(*) as count FROM alerts WHERE acknowledged = 0 GROUP BY org_id`).all() as Array<{ org_id: string; count: number }>)
        .map(r => [r.org_id, r.count])
    );
    const tokenUsage = new Map(
      (db.prepare(`SELECT a.org_id, COALESCE(SUM(tu.input_tokens + tu.output_tokens), 0) as total FROM token_usage tu JOIN accounts a ON tu.account_id = a.id WHERE tu.recorded_at >= date('now') GROUP BY a.org_id`).all() as Array<{ org_id: string; total: number }>)
        .map(r => [r.org_id, r.total])
    );

    const enriched = orgs.map((org) => ({
      ...org,
      projectCount: projectCounts.get(org.id) ?? 0,
      activeSessions: sessionCounts.get(org.id) ?? 0,
      unackedAlerts: alertCounts.get(org.id) ?? 0,
      todayTokens: tokenUsage.get(org.id) ?? 0,
    }));

    return { success: true, data: enriched };
  });
}
