/**
 * Thought-layer endpoints:
 *   POST /api/brain/thoughts                     capture
 *   GET  /api/brain/thoughts/:id                 get with optional include
 *   GET  /api/brain/thoughts?project_id=&...     list recent
 *   POST /api/brain/thoughts/search              semantic/lexical search
 *   GET  /api/brain/thoughts/stats?project_id=   aggregated counts
 *   POST /api/brain/thoughts/promote-artifact    archive → thought
 *   POST /api/brain/thoughts/unarchive           restore soft-archived thoughts
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { captureThoughtAsync } from "../thoughts/capture.js";
import { getThought } from "../thoughts/get.js";
import { listThoughts } from "../thoughts/list.js";
import { searchThoughts } from "../thoughts/search.js";
import { thoughtStats } from "../thoughts/stats.js";
import { promoteArtifact } from "../thoughts/promote.js";
import { unarchiveThoughts } from "../jobs/thought-consolidator.js";
import { CaptureThoughtRequest, ThoughtType } from "../thoughts/types.js";

const searchBody = z.object({
  org_id: z.string().min(1),
  project_id: z.string().min(1),
  query: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(10),
  threshold: z.number().min(0).max(1).default(0.5),
  scope: z.enum(["project", "org"]).default("project"),
  include_hidden: z.boolean().default(false),
  include_archived: z.boolean().default(false),
});

const listQuery = z.object({
  org_id: z.string().min(1),
  project_id: z.string().min(1),
  type: ThoughtType.optional(),
  topic: z.string().optional(),
  person: z.string().optional(),
  days: z.coerce.number().int().min(1).max(3650).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(20),
  include_hidden: z.coerce.boolean().default(false),
  // Not z.coerce.boolean(): that turns the query-string "false" into true.
  include_archived: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .default(false)
    .transform((v) => v === true || v === "true" || v === "1"),
});

const unarchiveBody = z.object({
  org_id: z.string().min(1),
  ids: z.array(z.string().min(1)).min(1).max(1000),
  /** Pin by default: an explicit "keep this" must survive the next sweep. */
  pin: z.boolean().default(true),
});

const statsQuery = z.object({
  org_id: z.string().min(1),
  project_id: z.string().min(1),
  scope: z.enum(["project", "org"]).default("project"),
});

const promoteBody = z.object({
  archive_hash: z.string().length(64),
  org_id: z.string().min(1),
  project_id: z.string().min(1),
  thought_type_hint: ThoughtType.optional(),
  relation: z.string().optional(),
});

function err400(reply: FastifyReply, msg: string) {
  return reply.status(400).send({
    error: { code: "MISSING_FIELD", message: msg },
  });
}

export function registerBrainThoughtsRoutes(fastify: FastifyInstance): void {
  // POST /api/brain/thoughts — capture (semantic dedup when vec available)
  fastify.post("/api/brain/thoughts", async (request, reply) => {
    const parsed = CaptureThoughtRequest.safeParse(request.body);
    if (!parsed.success) return err400(reply, parsed.error.message);
    const result = await captureThoughtAsync(parsed.data);
    reply.status(201).send(result);
  });

  // GET /api/brain/thoughts/:id
  fastify.get<{
    Params: { id: string };
    Querystring: { org_id: string; include?: string };
  }>("/api/brain/thoughts/:id", async (request, reply) => {
    const { id } = request.params;
    const q = z
      .object({ org_id: z.string().min(1), include: z.string().optional() })
      .safeParse(request.query);
    if (!q.success) return err400(reply, q.error.message);
    const includes = new Set(
      (q.data.include ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    );
    const thought = getThought(q.data.org_id, id, includes);
    if (!thought) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: `thought ${id} not found` },
      });
    }
    reply.send(thought);
  });

  // GET /api/brain/thoughts  — list recent
  fastify.get<{
    Querystring: z.input<typeof listQuery>;
  }>("/api/brain/thoughts", async (request, reply) => {
    const q = listQuery.safeParse(request.query);
    if (!q.success) return err400(reply, q.error.message);
    const items = listThoughts({
      orgId: q.data.org_id,
      projectId: q.data.project_id,
      type: q.data.type,
      topic: q.data.topic,
      person: q.data.person,
      days: q.data.days,
      limit: q.data.limit,
      includeHidden: q.data.include_hidden,
      includeArchived: q.data.include_archived,
    });
    reply.send({ items });
  });

  // POST /api/brain/thoughts/search  — lexical FTS
  fastify.post("/api/brain/thoughts/search", async (request, reply) => {
    const parsed = searchBody.safeParse(request.body);
    if (!parsed.success) return err400(reply, parsed.error.message);
    const results = searchThoughts({
      orgId: parsed.data.org_id,
      projectId: parsed.data.project_id,
      query: parsed.data.query,
      limit: parsed.data.limit,
      threshold: parsed.data.threshold,
      scope: parsed.data.scope,
      includeHidden: parsed.data.include_hidden,
      includeArchived: parsed.data.include_archived,
    });
    reply.send({ results });
  });

  // POST /api/brain/thoughts/unarchive — reverse the sleep-time consolidator
  fastify.post("/api/brain/thoughts/unarchive", async (request, reply) => {
    const parsed = unarchiveBody.safeParse(request.body);
    if (!parsed.success) return err400(reply, parsed.error.message);
    reply.send(
      unarchiveThoughts({
        org_id: parsed.data.org_id,
        ids: parsed.data.ids,
        pin: parsed.data.pin,
      }),
    );
  });

  // GET /api/brain/thoughts/stats
  fastify.get<{
    Querystring: z.input<typeof statsQuery>;
  }>("/api/brain/thoughts/stats", async (request, reply) => {
    const q = statsQuery.safeParse(request.query);
    if (!q.success) return err400(reply, q.error.message);
    const stats = thoughtStats(q.data.org_id, q.data.project_id, q.data.scope);
    reply.send(stats);
  });

  // POST /api/brain/thoughts/promote-artifact
  fastify.post("/api/brain/thoughts/promote-artifact", async (request, reply) => {
    const parsed = promoteBody.safeParse(request.body);
    if (!parsed.success) return err400(reply, parsed.error.message);
    try {
      const result = promoteArtifact(parsed.data);
      reply.status(201).send(result);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      reply.status(404).send({ error: { code: "NOT_FOUND", message } });
    }
  });
}
