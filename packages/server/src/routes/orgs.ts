import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  LIVE_SESSION_STATUSES_SQL,
  ORG_COLOR_RE,
  ORG_NAME_MAX,
  ORG_SLUG_RE,
  OrgError,
  createOrg,
  deleteOrg,
  listOrgs,
  orgApiKeyEnvName,
  updateOrg,
} from "@nosleep/shared";
import { getBrainRoot } from "../brain/config.js";
import { getLogger } from "../logger.js";

const log = getLogger("orgs");

const colorSchema = z.string().regex(ORG_COLOR_RE, "color must be a hex colour like #3b82f6");

const createOrgSchema = z.object({
  name: z.string().trim().min(1).max(ORG_NAME_MAX),
  slug: z.string().regex(ORG_SLUG_RE, "slug must be a-z, 0-9 and '-' (max 40)").optional(),
  color: colorSchema.optional(),
});

const updateOrgSchema = z
  .object({
    name: z.string().trim().min(1).max(ORG_NAME_MAX).optional(),
    color: colorSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.color !== undefined, { message: "nothing to update (name, color)" });

const ORG_ERROR_STATUS: Record<OrgError["code"], number> = {
  invalid: 400,
  not_found: 404,
  conflict: 409,
  not_empty: 409,
  protected: 409,
};

function sendOrgError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof OrgError) {
    return reply.status(ORG_ERROR_STATUS[err.code]).send({ success: false, error: err.message, code: err.code });
  }
  throw err;
}

/** A key bound to one org may not create/delete orgs, nor edit another org. */
function denyBound(request: FastifyRequest, reply: FastifyReply, targetOrgId?: string): boolean {
  if (!request.orgId) return false;
  if (targetOrgId && request.orgId === targetOrgId) return false;
  reply.status(403).send({ success: false, error: `key is bound to ${request.orgId}; org management needs the admin key` });
  return true;
}

/**
 * Brain artifacts/thoughts for an org live outside the main DB
 * (data/brain/<org_id>/active.db). Count them so an org with brain data is
 * never deleted out from under its files.
 */
function brainDataCount(orgId: string): number {
  const activeDb = path.join(getBrainRoot(), orgId, "active.db");
  if (!existsSync(activeDb)) return 0;
  const bdb = new Database(activeDb, { readonly: true, fileMustExist: true });
  try {
    let total = 0;
    for (const table of ["artifacts", "thoughts"]) {
      const exists = bdb.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
      if (exists) total += (bdb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    }
    return total;
  } finally {
    bdb.close();
  }
}

export function registerOrgRoutes(
  fastify: FastifyInstance,
  db: Database.Database,
): void {
  // List all organizations with summary stats
  fastify.get("/api/orgs", async () => {
    const orgs = listOrgs(db);

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
      apiKeyEnv: orgApiKeyEnvName(org.slug),
      projectCount: projectCounts.get(org.id) ?? 0,
      activeSessions: sessionCounts.get(org.id) ?? 0,
      unackedAlerts: alertCounts.get(org.id) ?? 0,
      todayTokens: tokenUsage.get(org.id) ?? 0,
    }));

    return { success: true, data: enriched };
  });

  // Create an org
  fastify.post("/api/orgs", async (request, reply) => {
    if (denyBound(request, reply)) return reply;
    const parsed = createOrgSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    try {
      const org = createOrg(db, parsed.data);
      log.info({ orgId: org.id }, "org created");
      return reply.status(201).send({ success: true, data: { ...org, apiKeyEnv: orgApiKeyEnvName(org.slug) } });
    } catch (err) {
      return sendOrgError(reply, err);
    }
  });

  // Rename / recolour an org
  fastify.patch("/api/orgs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (denyBound(request, reply, id)) return reply;
    const parsed = updateOrgSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    try {
      const org = updateOrg(db, id, parsed.data);
      return { success: true, data: { ...org, apiKeyEnv: orgApiKeyEnvName(org.slug) } };
    } catch (err) {
      return sendOrgError(reply, err);
    }
  });

  // Delete an org — only when it owns no data anywhere (409 otherwise)
  fastify.delete("/api/orgs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (denyBound(request, reply)) return reply;
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      return reply.status(404).send({ success: false, error: `org ${id} not found`, code: "not_found" });
    }
    try {
      const brainRows = brainDataCount(id);
      if (brainRows > 0) {
        return reply.status(409).send({
          success: false,
          code: "not_empty",
          error: `org still has brain data (${brainRows} artifacts/thoughts) — delete it first`,
        });
      }
      deleteOrg(db, id);
      log.info({ orgId: id }, "org deleted");
      return { success: true, data: { id } };
    } catch (err) {
      return sendOrgError(reply, err);
    }
  });
}
