import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";

/**
 * Metrics endpoints — derive observability data from the existing tables.
 * No new persisted aggregates; queries are bounded with LIMITs and time windows.
 */
export function registerMetricsRoutes(
  fastify: FastifyInstance,
  db: Database.Database,
): void {
  // ── Aggregate snapshot for the dashboard ─────────────────
  fastify.get("/api/metrics", async (request) => {
    const { orgId, windowHours } = request.query as {
      orgId?: string;
      windowHours?: string;
    };
    const hours = clampInt(windowHours, 24, 1, 168);
    const sinceClause = `datetime('now', '-${hours} hours')`;
    const orgFilterSession = orgId ? `AND org_id = '${escapeOrgId(orgId)}'` : "";
    const orgFilterAlert = orgId ? `AND org_id = '${escapeOrgId(orgId)}'` : "";

    // Session duration metrics: median + avg in seconds for completed sessions
    const durationRows = db.prepare(`
      SELECT
        CAST((julianday(ended_at) - julianday(started_at)) * 86400 AS INTEGER) as duration_sec
      FROM sessions
      WHERE status IN ('completed', 'failed', 'stopped')
        AND ended_at IS NOT NULL
        AND started_at >= ${sinceClause}
        ${orgFilterSession}
      ORDER BY duration_sec
    `).all() as Array<{ duration_sec: number }>;

    const sessionDuration = computeQuantiles(durationRows.map((r) => r.duration_sec));

    // Token velocity: total tokens / total active session-hours in window
    const tokenRow = db.prepare(`
      SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total
      FROM token_usage
      WHERE recorded_at >= ${sinceClause}
    `).get() as { total: number };

    const sessionHoursRow = db.prepare(`
      SELECT COALESCE(SUM(
        CAST((julianday(COALESCE(ended_at, datetime('now'))) - julianday(started_at)) * 24 AS REAL)
      ), 0) as hours
      FROM sessions
      WHERE started_at >= ${sinceClause}
        ${orgFilterSession}
    `).get() as { hours: number };

    const tokenVelocityPerHour =
      sessionHoursRow.hours > 0 ? Math.round(tokenRow.total / sessionHoursRow.hours) : 0;

    // Drift frequency: number of drift alerts per session in window
    const driftCount = db.prepare(`
      SELECT COUNT(*) as n FROM alerts
      WHERE type = 'drift' AND created_at >= ${sinceClause} ${orgFilterAlert}
    `).get() as { n: number };

    const sessionsCount = db.prepare(`
      SELECT COUNT(*) as n FROM sessions
      WHERE started_at >= ${sinceClause} ${orgFilterSession}
    `).get() as { n: number };

    const driftPerSession =
      sessionsCount.n > 0 ? Number((driftCount.n / sessionsCount.n).toFixed(3)) : 0;

    // Escalation rate: alerts of type 'question' or severity 'critical' per session
    const escalationCount = db.prepare(`
      SELECT COUNT(*) as n FROM alerts
      WHERE (type = 'question' OR severity = 'critical')
        AND created_at >= ${sinceClause} ${orgFilterAlert}
    `).get() as { n: number };

    const escalationsPerSession =
      sessionsCount.n > 0 ? Number((escalationCount.n / sessionsCount.n).toFixed(3)) : 0;

    // Validation outcomes
    const validationRows = db.prepare(`
      SELECT verdict, COUNT(*) as n FROM validations
      WHERE created_at >= ${sinceClause}
      GROUP BY verdict
    `).all() as Array<{ verdict: string | null; n: number }>;
    const validationByVerdict: Record<string, number> = {};
    for (const r of validationRows) {
      validationByVerdict[r.verdict ?? "null"] = r.n;
    }

    return {
      success: true,
      data: {
        windowHours: hours,
        orgId: orgId ?? "all",
        generatedAt: new Date().toISOString(),
        sessions: {
          total: sessionsCount.n,
          durationSeconds: sessionDuration,
        },
        tokens: {
          total: tokenRow.total,
          velocityPerHour: tokenVelocityPerHour,
        },
        drift: {
          alertCount: driftCount.n,
          perSession: driftPerSession,
        },
        escalations: {
          alertCount: escalationCount.n,
          perSession: escalationsPerSession,
        },
        validation: validationByVerdict,
      },
    };
  });

  // ── Per-org breakdown ────────────────────────────────────
  fastify.get("/api/metrics/by-org", async (request) => {
    const { windowHours } = request.query as { windowHours?: string };
    const hours = clampInt(windowHours, 24, 1, 168);
    const sinceClause = `datetime('now', '-${hours} hours')`;

    const rows = db.prepare(`
      SELECT
        s.org_id,
        COUNT(*) as session_count,
        COALESCE(SUM(s.tokens_used), 0) as token_total,
        COALESCE(AVG(CAST((julianday(COALESCE(s.ended_at, datetime('now'))) - julianday(s.started_at)) * 86400 AS INTEGER)), 0) as avg_duration_sec
      FROM sessions s
      WHERE s.started_at >= ${sinceClause} AND s.org_id IS NOT NULL
      GROUP BY s.org_id
    `).all() as Array<{
      org_id: string;
      session_count: number;
      token_total: number;
      avg_duration_sec: number;
    }>;

    return { success: true, data: rows };
  });

  // ── Real daily token usage by org for the past N days. ───────────
  // Replaces the fabricated random data on the TokenUsage page.
  fastify.get("/api/metrics/tokens/daily", async (request) => {
    const { days } = request.query as { days?: string };
    const window = clampInt(days, 30, 1, 365);

    const rows = db
      .prepare(
        `SELECT
           strftime('%Y-%m-%d', tu.recorded_at) AS day,
           a.org_id                              AS org_id,
           COALESCE(SUM(tu.input_tokens + tu.output_tokens), 0) AS tokens
         FROM token_usage tu
         JOIN accounts a ON a.id = tu.account_id
         WHERE tu.recorded_at >= datetime('now', '-${window} days')
         GROUP BY day, a.org_id
         ORDER BY day ASC`,
      )
      .all() as Array<{ day: string; org_id: string; tokens: number }>;

    return { success: true, data: rows };
  });
}

function clampInt(raw: string | undefined, defaultVal: number, min: number, max: number): number {
  const n = raw ? parseInt(raw, 10) : defaultVal;
  if (Number.isNaN(n)) return defaultVal;
  return Math.max(min, Math.min(max, n));
}

function escapeOrgId(orgId: string): string {
  // Whitelist the only valid org IDs
  if (!/^org_[a-z_]+$/.test(orgId)) return "org_invalid";
  return orgId;
}

function computeQuantiles(sortedAsc: number[]): {
  count: number;
  p50: number;
  p95: number;
  max: number;
  avg: number;
} {
  if (sortedAsc.length === 0) {
    return { count: 0, p50: 0, p95: 0, max: 0, avg: 0 };
  }
  const p50 = sortedAsc[Math.floor(sortedAsc.length * 0.5)];
  const p95Idx = Math.min(sortedAsc.length - 1, Math.floor(sortedAsc.length * 0.95));
  const p95 = sortedAsc[p95Idx];
  const max = sortedAsc[sortedAsc.length - 1];
  const avg = Math.round(sortedAsc.reduce((a, b) => a + b, 0) / sortedAsc.length);
  return { count: sortedAsc.length, p50, p95, max, avg };
}
