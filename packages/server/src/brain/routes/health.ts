/**
 * GET /api/admin/brain/health — basic status: orgs known, recent ingest count.
 */

import type { FastifyInstance } from "fastify";
import fs from "node:fs";
import { getBrainRoot } from "../config.js";
import { activeDbFor } from "../storage/active-db.js";

export function registerBrainHealthRoutes(fastify: FastifyInstance): void {
  fastify.get("/api/admin/brain/health", async () => {
    const brainRoot = getBrainRoot();
    const orgs = fs.existsSync(brainRoot)
      ? fs
          .readdirSync(brainRoot, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
      : [];

    const since = Math.floor(Date.now() / 1000) - 3600; // last hour
    const perOrg = orgs.map((orgId) => {
      try {
        const db = activeDbFor(orgId);
        const row = db
          .prepare(
            `SELECT COUNT(*) AS c FROM ingest_events WHERE ts > ?`,
          )
          .get(since) as { c: number };
        const total = db
          .prepare(`SELECT COUNT(*) AS c FROM artifacts`)
          .get() as { c: number };
        return {
          org_id: orgId,
          recent_ingest_count: row.c,
          total_artifacts: total.c,
        };
      } catch (err) {
        return {
          org_id: orgId,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });

    return {
      brain_root: brainRoot,
      orgs: perOrg,
      now: Math.floor(Date.now() / 1000),
    };
  });
}
