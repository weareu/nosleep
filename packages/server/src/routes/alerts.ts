import type { FastifyInstance } from "fastify";
import type Database from "better-sqlite3";
import { eventBus } from "../event-bus.js";

interface AlertsListQuery {
  orgId?: string;
  unackedOnly?: string;
  type?: string;
  severity?: string;
  offset?: string;
  limit?: string;
}

const ALLOWED_SEVERITIES = new Set(["critical", "warning", "info"]);
const MAX_LIMIT = 500;

function buildAlertFilter(q: AlertsListQuery): {
  whereSql: string;
  params: unknown[];
} {
  const conds: string[] = ["1=1"];
  const params: unknown[] = [];

  if (q.orgId) {
    conds.push("a.org_id = ?");
    params.push(q.orgId);
  }
  if (q.unackedOnly === "true") {
    conds.push("a.acknowledged = 0");
  }
  if (q.type) {
    conds.push("a.type = ?");
    params.push(q.type);
  }
  if (q.severity && ALLOWED_SEVERITIES.has(q.severity)) {
    conds.push("a.severity = ?");
    params.push(q.severity);
  }

  return { whereSql: conds.join(" AND "), params };
}

export function registerAlertRoutes(
  fastify: FastifyInstance,
  db: Database.Database,
): void {
  // List alerts. Supports server-side filtering (org, severity, type,
  // unacked) + offset/limit pagination. Response shape stays an array so
  // existing test harness and mobile client keep working.
  fastify.get("/api/alerts", async (request) => {
    const q = request.query as AlertsListQuery;
    const { whereSql, params } = buildAlertFilter(q);

    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, parseInt(q.limit ?? "50", 10) || 50),
    );
    const offset = Math.max(0, parseInt(q.offset ?? "0", 10) || 0);

    const sql = `
      SELECT a.*, o.name as org_name, o.slug as org_slug, o.color as org_color,
        p.name as project_name
      FROM alerts a
      JOIN organizations o ON a.org_id = o.id
      LEFT JOIN projects p ON a.project_id = p.id
      WHERE ${whereSql}
      ORDER BY a.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const rows = db.prepare(sql).all(...params, limit, offset);
    return { success: true, data: rows };
  });

  // Count alerts matching the same filter set. Cheap — no JOINs, no
  // ordering, just COUNT(*). Powers the sidebar badge so it doesn't have
  // to fetch up to limit rows just to count them, and lets the Alerts
  // page paginate with a true total.
  fastify.get("/api/alerts/count", async (request) => {
    const q = request.query as AlertsListQuery;
    const { whereSql, params } = buildAlertFilter(q);
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM alerts a WHERE ${whereSql}`)
      .get(...params) as { n: number };
    return { success: true, data: { count: row.n } };
  });

  // Acknowledge an alert
  fastify.post("/api/alerts/:id/ack", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = db.prepare(`UPDATE alerts SET acknowledged = 1 WHERE id = ?`).run(id);

    if (result.changes === 0) {
      return reply.status(404).send({ success: false, error: "Alert not found" });
    }

    eventBus.emit("alert:ack", parseInt(id, 10));
    return { success: true };
  });

  // Phase 12 (UI review L2) — un-acknowledge for the Alerts page Undo
  // toast. Emits a distinct event so any consumer that wants to tell
  // ack from unack can; the catch-all "alert:changed" path is what the
  // dashboard's invalidation hook listens for.
  fastify.post("/api/alerts/:id/unack", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = db.prepare(`UPDATE alerts SET acknowledged = 0 WHERE id = ?`).run(id);

    if (result.changes === 0) {
      return reply.status(404).send({ success: false, error: "Alert not found" });
    }

    eventBus.emit("alert:unack", parseInt(id, 10));
    return { success: true };
  });

  // Acknowledge all alerts for an org
  fastify.post("/api/alerts/ack-all", async (request) => {
    const { orgId } = request.query as { orgId?: string };

    if (orgId) {
      db.prepare(`UPDATE alerts SET acknowledged = 1 WHERE org_id = ? AND acknowledged = 0`).run(orgId);
    } else {
      db.prepare(`UPDATE alerts SET acknowledged = 1 WHERE acknowledged = 0`).run();
    }

    return { success: true };
  });
}
