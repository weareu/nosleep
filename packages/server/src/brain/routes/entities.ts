/**
 * Entity + thought_refs + related_thoughts REST routes.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  listEntities,
  getEntity,
  addAlias,
  mergeInto,
  EntityMergeError,
} from "../entities/api.js";
import {
  addThoughtRef,
  ThoughtRefError,
  type ThoughtRefRelation,
} from "../thoughts/refs.js";
import { relatedThoughts } from "../thoughts/related.js";
import { EntityKind } from "../entities/types.js";

function err400(reply: FastifyReply, msg: string) {
  return reply.status(400).send({
    error: { code: "MISSING_FIELD", message: msg },
  });
}

const thoughtRefBody = z.object({
  org_id: z.string().min(1),
  from_thought_id: z.string().min(1),
  to_thought_id: z.string().min(1),
  relation: z.enum([
    "refines",
    "supersedes",
    "contradicts",
    "continues",
    "related_to",
    "duplicate_of",
    "answers",
    "asks_about",
    "derives_from_thought",
  ]),
  origin: z
    .enum(["user_linked", "llm_suggested", "derived_cooccurrence", "skill_generated"])
    .optional(),
});

const relatedQuery = z.object({
  org_id: z.string().min(1),
  modalities: z.string().optional(), // comma-sep
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

const entitiesListQuery = z.object({
  org_id: z.string().min(1),
  project_id: z.string().optional(),
  kind: EntityKind.optional(),
  order: z.enum(["frequency", "recent", "alpha"]).default("frequency"),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

const entityGetQuery = z.object({
  org_id: z.string().min(1),
  include_hidden: z.coerce.boolean().default(false),
});

const aliasBody = z.object({
  org_id: z.string().min(1),
  alias: z.string().min(1).max(120),
});

const mergeBody = z.object({
  org_id: z.string().min(1),
  target_entity_id: z.string().min(1),
});

export function registerBrainEntityRoutes(fastify: FastifyInstance): void {
  // GET /api/brain/entities
  fastify.get<{ Querystring: z.input<typeof entitiesListQuery> }>(
    "/api/brain/entities",
    async (request, reply) => {
      const q = entitiesListQuery.safeParse(request.query);
      if (!q.success) return err400(reply, q.error.message);
      const items = listEntities({
        orgId: q.data.org_id,
        projectId: q.data.project_id,
        kind: q.data.kind,
        order: q.data.order,
        limit: q.data.limit,
      });
      reply.send({ items });
    },
  );

  // GET /api/brain/entities/:id
  fastify.get<{
    Params: { id: string };
    Querystring: z.input<typeof entityGetQuery>;
  }>("/api/brain/entities/:id", async (request, reply) => {
    const q = entityGetQuery.safeParse(request.query);
    if (!q.success) return err400(reply, q.error.message);
    const entity = getEntity(q.data.org_id, request.params.id, q.data.include_hidden);
    if (!entity) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: `entity ${request.params.id} not found` },
      });
    }
    reply.send(entity);
  });

  // POST /api/brain/entities/:id/aliases
  fastify.post<{ Params: { id: string } }>(
    "/api/brain/entities/:id/aliases",
    async (request, reply) => {
      const parsed = aliasBody.safeParse(request.body);
      if (!parsed.success) return err400(reply, parsed.error.message);
      const added = addAlias(parsed.data.org_id, request.params.id, parsed.data.alias);
      reply.send({ added });
    },
  );

  // POST /api/brain/entities/:id/merge-into
  fastify.post<{ Params: { id: string } }>(
    "/api/brain/entities/:id/merge-into",
    async (request, reply) => {
      const parsed = mergeBody.safeParse(request.body);
      if (!parsed.success) return err400(reply, parsed.error.message);
      try {
        mergeInto(parsed.data.org_id, request.params.id, parsed.data.target_entity_id);
        reply.send({ merged: true });
      } catch (e) {
        if (e instanceof EntityMergeError) {
          return reply.status(400).send({
            error: { code: e.code, message: e.message },
          });
        }
        throw e;
      }
    },
  );

  // POST /api/brain/thought-refs  — manual edge
  fastify.post("/api/brain/thought-refs", async (request, reply) => {
    const parsed = thoughtRefBody.safeParse(request.body);
    if (!parsed.success) return err400(reply, parsed.error.message);
    try {
      const result = addThoughtRef({
        org_id: parsed.data.org_id,
        from_thought_id: parsed.data.from_thought_id,
        to_thought_id: parsed.data.to_thought_id,
        relation: parsed.data.relation as ThoughtRefRelation,
        origin: parsed.data.origin,
      });
      reply.status(201).send(result);
    } catch (e) {
      if (e instanceof ThoughtRefError) {
        return reply.status(e.code === "NOT_FOUND" ? 404 : 400).send({
          error: { code: e.code, message: e.message },
        });
      }
      throw e;
    }
  });

  // GET /api/brain/thoughts/:id/related
  fastify.get<{
    Params: { id: string };
    Querystring: z.input<typeof relatedQuery>;
  }>("/api/brain/thoughts/:id/related", async (request, reply) => {
    const q = relatedQuery.safeParse(request.query);
    if (!q.success) return err400(reply, q.error.message);
    const modalities = q.data.modalities
      ? (q.data.modalities
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean) as Array<
          "edges" | "entities" | "shared_session" | "topics"
        >)
      : undefined;
    const items = relatedThoughts(q.data.org_id, request.params.id, {
      modalities,
      limit: q.data.limit,
    });
    reply.send({ items });
  });
}
