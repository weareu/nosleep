/**
 * Phase 10 — admin endpoints for the LLM-suggested thought_refs queue.
 *
 *   POST /api/brain/admin/suggestions/run        kick the proposer for a project
 *   GET  /api/brain/admin/suggestions/list       list unreviewed (default) or all
 *   POST /api/brain/admin/suggestions/:id/decide approve | reject
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { activeDbFor } from "../storage/active-db.js";
import { runThoughtRefProposer } from "../proposer/thought-ref-proposer.js";

const runBody = z.object({
  org_id: z.string().min(1),
  project_id: z.string().min(1),
  max_pairs: z.number().int().min(1).max(2000).optional(),
  cosine_floor: z.number().min(0).max(1).optional(),
  dry_run: z.boolean().optional(),
});

const listQuery = z.object({
  org_id: z.string().min(1),
  project_id: z.string().optional(),
  // z.coerce.boolean() treats "false" as truthy; do it manually.
  reviewed: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (typeof v === "boolean") return v;
      return v === "true" || v === "1";
    }),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

const decideBody = z.object({
  org_id: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
});

interface SuggestionRow {
  id: string;
  org_id: string;
  project_id: string;
  from_thought_id: string;
  to_thought_id: string;
  relation: string;
  confidence: number;
  cosine: number | null;
  justification: string | null;
  proposer_model: string;
  created_at: number;
  reviewed: number;
  reviewed_at: number | null;
  decision: string | null;
  from_content: string | null;
  to_content: string | null;
  from_thought_type: string | null;
  to_thought_type: string | null;
}

function err400(reply: FastifyReply, msg: string) {
  return reply
    .status(400)
    .send({ error: { code: "MISSING_FIELD", message: msg } });
}

export function registerBrainSuggestionRoutes(fastify: FastifyInstance): void {
  fastify.post("/api/brain/admin/suggestions/run", async (request, reply) => {
    const parsed = runBody.safeParse(request.body);
    if (!parsed.success) return err400(reply, parsed.error.message);
    const result = await runThoughtRefProposer(parsed.data);
    reply.send(result);
  });

  fastify.get<{ Querystring: z.input<typeof listQuery> }>(
    "/api/brain/admin/suggestions/list",
    async (request, reply) => {
      const q = listQuery.safeParse(request.query);
      if (!q.success) return err400(reply, q.error.message);
      const db = activeDbFor(q.data.org_id);

      const conds = ["s.org_id = ?"];
      const params: (string | number)[] = [q.data.org_id];
      if (q.data.project_id) {
        conds.push("s.project_id = ?");
        params.push(q.data.project_id);
      }
      if (q.data.reviewed !== undefined) {
        conds.push("s.reviewed = ?");
        params.push(q.data.reviewed ? 1 : 0);
      }

      const rows = db
        .prepare(
          `SELECT s.*,
                  ta.content AS from_content, ta.thought_type AS from_thought_type,
                  tb.content AS to_content,   tb.thought_type AS to_thought_type
             FROM thought_ref_suggestions s
             LEFT JOIN thoughts ta ON ta.id = s.from_thought_id
             LEFT JOIN thoughts tb ON tb.id = s.to_thought_id
            WHERE ${conds.join(" AND ")}
            ORDER BY s.reviewed ASC, s.created_at DESC
            LIMIT ?`,
        )
        .all(...params, q.data.limit) as SuggestionRow[];

      reply.send({ items: rows });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/api/brain/admin/suggestions/:id/decide",
    async (request, reply) => {
      const parsed = decideBody.safeParse(request.body);
      if (!parsed.success) return err400(reply, parsed.error.message);
      const { id } = request.params;
      const db = activeDbFor(parsed.data.org_id);

      const sug = db
        .prepare(
          `SELECT * FROM thought_ref_suggestions WHERE id = ? AND org_id = ?`,
        )
        .get(id, parsed.data.org_id) as SuggestionRow | undefined;

      if (!sug) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "suggestion not found" },
        });
      }
      if (sug.reviewed === 1) {
        return reply.status(409).send({
          error: { code: "ALREADY_REVIEWED", message: "suggestion already decided" },
        });
      }

      const now = Math.floor(Date.now() / 1000);

      // Phase 12 — wrap insert + reviewed-flag update in a single
      // transaction so a crash between them can't leave a partial state
      // (thought_ref present but suggestion unreviewed → audit lies).
      try {
        const tx = db.transaction(() => {
          if (parsed.data.decision === "approve") {
            db.prepare(
              `INSERT OR IGNORE INTO thought_refs
               (from_thought_id, to_thought_id, relation, scope, origin,
                project_id, created_at)
               VALUES (?, ?, ?, 'intra_project', 'llm_suggested_approved', ?, ?)`,
            ).run(
              sug.from_thought_id,
              sug.to_thought_id,
              sug.relation,
              sug.project_id,
              now,
            );
          }
          db.prepare(
            `UPDATE thought_ref_suggestions
                SET reviewed = 1, reviewed_at = ?, decision = ?
              WHERE id = ? AND reviewed = 0`,
          ).run(now, parsed.data.decision, id);
        });
        tx();
      } catch (e) {
        return reply.status(500).send({
          error: {
            code: "INSERT_FAILED",
            message: e instanceof Error ? e.message : String(e),
          },
        });
      }

      reply.send({
        id,
        decision: parsed.data.decision,
        applied: parsed.data.decision === "approve",
      });
    },
  );
}
