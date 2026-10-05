/**
 * GET /api/brain/graph    — node/edge response for D3 view
 * POST /api/brain/graph/recompute — refresh thought_cooccur for a project
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import type Database from "better-sqlite3";
import { z } from "zod";
import { buildGraph } from "../graph/api.js";
import { computeCooccurForProject } from "../graph/cooccur.js";

const graphQuery = z.object({
  org_id: z.string().min(1),
  project_id: z.string().min(1),
  layers: z.string().optional(),
  since: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(50).max(1200).default(500),
  include_hidden: z.coerce.boolean().default(false),
  // Phase 22-E — time-decay tau in days. 0 = no decay.
  decay_tau_days: z.coerce.number().min(0).max(3650).default(0),
});

const recomputeBody = z.object({
  org_id: z.string().min(1),
  project_id: z.string().min(1),
});

function err400(reply: FastifyReply, msg: string) {
  return reply.status(400).send({
    error: { code: "MISSING_FIELD", message: msg },
  });
}

export function registerBrainGraphRoutes(
  fastify: FastifyInstance,
  mainDb?: Database.Database,
): void {
  fastify.get<{ Querystring: z.input<typeof graphQuery> }>(
    "/api/brain/graph",
    async (request, reply) => {
      const q = graphQuery.safeParse(request.query);
      if (!q.success) return err400(reply, q.error.message);
      const layers = q.data.layers
        ? (q.data.layers
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean) as Array<"thoughts" | "entities" | "archive">)
        : undefined;
      const result = buildGraph({
        org_id: q.data.org_id,
        project_id: q.data.project_id,
        layers,
        since: q.data.since,
        limit: q.data.limit,
        include_hidden: q.data.include_hidden,
        decay_tau_days: q.data.decay_tau_days,
        mainDb,
      });
      reply.send(result);
    },
  );

  fastify.post("/api/brain/graph/recompute", async (request, reply) => {
    const parsed = recomputeBody.safeParse(request.body);
    if (!parsed.success) return err400(reply, parsed.error.message);
    const result = computeCooccurForProject(
      parsed.data.org_id,
      parsed.data.project_id,
    );
    reply.send(result);
  });
}
