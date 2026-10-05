/**
 * Phase 10 — entity merge proposal queue.
 *
 *   POST /api/brain/admin/merge-proposals          create proposal
 *   GET  /api/brain/admin/merge-proposals/list     list unreviewed
 *   POST /api/brain/admin/merge-proposals/:id/decide  approve|reject
 *
 * Approve calls into entities/api.ts mergeInto() to set merged_into;
 * reject just marks reviewed. Both write a brain_session_events audit row.
 *
 * Also hosts the thought lint-pass jobs: thought-merge-proposals (22-E
 * near-dup detector) and thought-consolidation (22-F sleep-time archive).
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { nanoid } from "nanoid";
import { activeDbFor } from "../storage/active-db.js";
import { mergeInto, EntityMergeError } from "../entities/api.js";
import { runThoughtDedup } from "../jobs/thought-dedup.js";
import {
  runThoughtConsolidation,
  listConsolidationRuns,
} from "../jobs/thought-consolidator.js";
import { recordBrainAdminEvent } from "../storage/admin-events.js";

const createBody = z.object({
  org_id: z.string().min(1),
  from_entity_id: z.string().min(1),
  to_entity_id: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  rationale: z.string().max(2_000).optional(),
  proposer: z.string().max(64).optional(),
});

const listQuery = z.object({
  org_id: z.string().min(1),
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

const consolidateBody = z.object({
  org_id: z.string().min(1),
  dry_run: z.boolean().default(false),
  stale_days: z.number().int().min(7).max(3650).optional(),
  max_per_run: z.number().int().min(1).max(5000).optional(),
});

const runsQuery = z.object({
  org_id: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(200).default(20),
});

interface MergeProposalRow {
  id: string;
  org_id: string;
  from_entity_id: string;
  to_entity_id: string;
  confidence: number;
  rationale: string | null;
  proposer: string;
  created_at: number;
  reviewed: number;
  reviewed_at: number | null;
  decision: string | null;
  from_kind?: string | null;
  from_canonical?: string | null;
  to_kind?: string | null;
  to_canonical?: string | null;
}

function err400(reply: FastifyReply, msg: string) {
  return reply
    .status(400)
    .send({ error: { code: "MISSING_FIELD", message: msg } });
}

export function registerBrainMergeQueueRoutes(
  fastify: FastifyInstance,
): void {
  fastify.post(
    "/api/brain/admin/merge-proposals",
    async (request, reply) => {
      const parsed = createBody.safeParse(request.body);
      if (!parsed.success) return err400(reply, parsed.error.message);
      const { org_id, from_entity_id, to_entity_id } = parsed.data;
      if (from_entity_id === to_entity_id) {
        return err400(reply, "from_entity_id and to_entity_id must differ");
      }
      const db = activeDbFor(org_id);
      const id = nanoid();
      try {
        db.prepare(
          `INSERT INTO entity_merge_proposals
           (id, org_id, from_entity_id, to_entity_id, confidence, rationale,
            proposer, created_at, reviewed)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        ).run(
          id,
          org_id,
          from_entity_id,
          to_entity_id,
          parsed.data.confidence ?? 0,
          parsed.data.rationale ?? null,
          parsed.data.proposer ?? "system",
          Math.floor(Date.now() / 1000),
        );
        return reply.status(201).send({ id });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("UNIQUE")) {
          return reply.status(409).send({
            error: {
              code: "DUPLICATE",
              message: "a proposal already exists for this pair",
            },
          });
        }
        return reply.status(500).send({
          error: { code: "INSERT_FAILED", message: msg },
        });
      }
    },
  );

  fastify.get<{ Querystring: z.input<typeof listQuery> }>(
    "/api/brain/admin/merge-proposals/list",
    async (request, reply) => {
      const q = listQuery.safeParse(request.query);
      if (!q.success) return err400(reply, q.error.message);
      const db = activeDbFor(q.data.org_id);

      const conds = ["p.org_id = ?"];
      const params: (string | number)[] = [q.data.org_id];
      if (q.data.reviewed !== undefined) {
        conds.push("p.reviewed = ?");
        params.push(q.data.reviewed ? 1 : 0);
      }

      const rows = db
        .prepare(
          `SELECT p.*,
                  fe.kind AS from_kind, fe.canonical_name AS from_canonical,
                  te.kind AS to_kind,   te.canonical_name AS to_canonical
             FROM entity_merge_proposals p
             LEFT JOIN entities fe ON fe.id = p.from_entity_id
             LEFT JOIN entities te ON te.id = p.to_entity_id
            WHERE ${conds.join(" AND ")}
            ORDER BY p.reviewed ASC, p.created_at DESC
            LIMIT ?`,
        )
        .all(...params, q.data.limit) as MergeProposalRow[];

      reply.send({ items: rows });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/api/brain/admin/merge-proposals/:id/decide",
    async (request, reply) => {
      const parsed = decideBody.safeParse(request.body);
      if (!parsed.success) return err400(reply, parsed.error.message);
      const { id } = request.params;
      const db = activeDbFor(parsed.data.org_id);

      const proposal = db
        .prepare(
          `SELECT * FROM entity_merge_proposals
            WHERE id = ? AND org_id = ?`,
        )
        .get(id, parsed.data.org_id) as MergeProposalRow | undefined;

      if (!proposal) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "proposal not found" },
        });
      }
      if (proposal.reviewed === 1) {
        return reply.status(409).send({
          error: {
            code: "ALREADY_REVIEWED",
            message: "proposal already decided",
          },
        });
      }

      const now = Math.floor(Date.now() / 1000);
      let applied = false;
      let mergeError: string | null = null;

      // Phase 12 — wrap mergeInto + reviewed-flag update + audit in a
      // single transaction. The double-decide race + partial-write
      // window are both closed; UPDATE WHERE reviewed=0 ensures only
      // one parallel approver wins.
      try {
        const tx = db.transaction(() => {
          if (parsed.data.decision === "approve") {
            mergeInto(
              parsed.data.org_id,
              proposal.from_entity_id,
              proposal.to_entity_id,
            );
            applied = true;
          }
          db.prepare(
            `UPDATE entity_merge_proposals
                SET reviewed = 1, reviewed_at = ?, decision = ?
              WHERE id = ? AND reviewed = 0`,
          ).run(now, parsed.data.decision, id);
        });
        tx();
      } catch (e) {
        if (e instanceof EntityMergeError) {
          mergeError = e.message;
          return reply.status(400).send({
            error: { code: e.code, message: e.message },
          });
        }
        throw e;
      }

      recordBrainAdminEvent(parsed.data.org_id, "entity_merge_decision", {
        proposal_id: id,
        from_entity_id: proposal.from_entity_id,
        to_entity_id: proposal.to_entity_id,
        decision: parsed.data.decision,
        applied,
      });

      reply.send({
        id,
        decision: parsed.data.decision,
        applied,
        merge_error: mergeError,
      });
    },
  );

  // Phase 22-E — thought merge proposals.

  fastify.post(
    "/api/brain/admin/thought-merge-proposals/run",
    async (request, reply) => {
      const body = request.body as { org_id?: string; project_id?: string; threshold?: number; limit?: number };
      if (!body.org_id) return err400(reply, "org_id required");
      const result = await runThoughtDedup({
        org_id: body.org_id,
        project_id: body.project_id,
        threshold: body.threshold,
        limit: body.limit,
      });
      reply.send(result);
    },
  );

  // Phase 22-F — sleep-time consolidator (manual trigger + run history).
  // The same job runs daily from jobs/maintenance.ts.

  fastify.post(
    "/api/brain/admin/thought-consolidation/run",
    async (request, reply) => {
      const parsed = consolidateBody.safeParse(request.body ?? {});
      if (!parsed.success) return err400(reply, parsed.error.message);
      const result = runThoughtConsolidation({
        org_id: parsed.data.org_id,
        dry_run: parsed.data.dry_run,
        stale_days: parsed.data.stale_days,
        max_per_run: parsed.data.max_per_run,
        trigger: "manual",
      });
      reply.send(result);
    },
  );

  fastify.get(
    "/api/brain/admin/thought-consolidation/runs",
    async (request, reply) => {
      const q = runsQuery.safeParse(request.query);
      if (!q.success) return err400(reply, q.error.message);
      reply.send({ items: listConsolidationRuns(q.data.org_id, q.data.limit) });
    },
  );

  fastify.get(
    "/api/brain/admin/thought-merge-proposals/list",
    async (request, reply) => {
      const q = request.query as { org_id?: string; reviewed?: string; limit?: string };
      if (!q.org_id) return err400(reply, "org_id required");
      const reviewedFilter =
        q.reviewed === "true" || q.reviewed === "1"
          ? 1
          : q.reviewed === "false" || q.reviewed === "0"
            ? 0
            : null;
      const limit = Math.min(500, Math.max(1, parseInt(q.limit ?? "50", 10) || 50));
      const db = activeDbFor(q.org_id);
      const conds = ["p.org_id = ?"];
      const params: (string | number)[] = [q.org_id];
      if (reviewedFilter !== null) {
        conds.push("p.reviewed = ?");
        params.push(reviewedFilter);
      }
      const rows = db
        .prepare(
          `SELECT p.id, p.project_id, p.from_thought_id, p.to_thought_id,
                  p.similarity, p.rationale, p.proposer, p.created_at,
                  p.reviewed, p.reviewed_at, p.decision,
                  ft.content AS from_content, ft.thought_type AS from_type,
                  tt.content AS to_content, tt.thought_type AS to_type
             FROM thought_merge_proposals p
             LEFT JOIN thoughts ft ON ft.id = p.from_thought_id
             LEFT JOIN thoughts tt ON tt.id = p.to_thought_id
            WHERE ${conds.join(" AND ")}
            ORDER BY p.reviewed ASC, p.similarity DESC, p.created_at DESC
            LIMIT ?`,
        )
        .all(...params, limit);
      reply.send({ items: rows });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/api/brain/admin/thought-merge-proposals/:id/decide",
    async (request, reply) => {
      const body = request.body as { org_id?: string; decision?: "approve" | "reject" };
      if (!body.org_id || !body.decision) {
        return err400(reply, "org_id + decision required");
      }
      const { id } = request.params;
      const db = activeDbFor(body.org_id);
      const proposal = db
        .prepare(`SELECT * FROM thought_merge_proposals WHERE id = ? AND org_id = ?`)
        .get(id, body.org_id) as
          | {
              id: string;
              from_thought_id: string;
              to_thought_id: string;
              reviewed: number;
            }
          | undefined;
      if (!proposal) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "proposal not found" },
        });
      }
      if (proposal.reviewed === 1) {
        return reply.status(409).send({
          error: { code: "ALREADY_REVIEWED", message: "already decided" },
        });
      }
      const now = Math.floor(Date.now() / 1000);
      let applied = false;
      const tx = db.transaction(() => {
        if (body.decision === "approve") {
          // "Merging" thoughts: mark the from-thought hidden (visibility
          // = "merged_into:<to>"). Keep both rows so historical
          // refs stay intact. Phase 22-F lint pass can later prune
          // hidden orphans.
          db.prepare(
            `UPDATE thoughts SET visibility = ?, updated_at = ? WHERE id = ?`,
          ).run(`merged_into:${proposal.to_thought_id}`, now, proposal.from_thought_id);
          applied = true;
        }
        db.prepare(
          `UPDATE thought_merge_proposals
              SET reviewed = 1, reviewed_at = ?, decision = ?
            WHERE id = ? AND reviewed = 0`,
        ).run(now, body.decision, id);
      });
      tx();
      recordBrainAdminEvent(body.org_id, "thought_merge_decision", {
        proposal_id: id,
        from_thought_id: proposal.from_thought_id,
        to_thought_id: proposal.to_thought_id,
        decision: body.decision,
        applied,
      });
      reply.send({ id, decision: body.decision, applied });
    },
  );
}
