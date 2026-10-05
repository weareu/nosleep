/**
 * Code-centric browse endpoints.
 *   GET /api/brain/code/symbols — symbol search/browse
 *   GET /api/brain/code/files   — distinct file_paths with snapshot counts
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { activeDbFor } from "../storage/active-db.js";

const symbolsQuery = z.object({
  org_id: z.string().min(1),
  project_id: z.string().min(1),
  q: z.string().optional(),
  symbol_kind: z.string().optional(),
  language: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

const filesQuery = z.object({
  org_id: z.string().min(1),
  project_id: z.string().min(1),
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

function err400(reply: FastifyReply, msg: string) {
  return reply.status(400).send({
    error: { code: "MISSING_FIELD", message: msg },
  });
}

export function registerBrainCodeRoutes(fastify: FastifyInstance): void {
  fastify.get<{ Querystring: z.input<typeof symbolsQuery> }>(
    "/api/brain/code/symbols",
    async (request, reply) => {
      const q = symbolsQuery.safeParse(request.query);
      if (!q.success) return err400(reply, q.error.message);

      const db = activeDbFor(q.data.org_id);
      const conds = ["a.org_id = ?", "a.project_id = ?"];
      const params: (string | number)[] = [q.data.org_id, q.data.project_id];

      if (q.data.q) {
        conds.push("(cs.symbol GLOB ? OR cs.file_path GLOB ?)");
        params.push(`*${q.data.q}*`, `*${q.data.q}*`);
      }
      if (q.data.symbol_kind) {
        conds.push("cs.symbol_kind = ?");
        params.push(q.data.symbol_kind);
      }
      if (q.data.language) {
        conds.push("cs.language = ?");
        params.push(q.data.language);
      }

      const rows = db
        .prepare(
          `SELECT cs.hash AS hash, cs.symbol AS symbol, cs.symbol_kind AS symbol_kind,
                  cs.line_start AS line_start, cs.line_end AS line_end,
                  cs.file_path AS file_path, cs.language AS language,
                  a.kind AS artifact_kind, a.ts AS ts
             FROM code_symbols cs
             JOIN artifacts a ON a.hash = cs.hash
            WHERE ${conds.join(" AND ")}
         ORDER BY cs.symbol ASC, a.ts DESC
            LIMIT ?`,
        )
        .all(...params, q.data.limit) as Array<{
        hash: string;
        symbol: string;
        symbol_kind: string;
        line_start: number | null;
        line_end: number | null;
        file_path: string | null;
        language: string;
        artifact_kind: string;
        ts: number;
      }>;

      reply.send({ items: rows, total: rows.length });
    },
  );

  fastify.get<{ Querystring: z.input<typeof filesQuery> }>(
    "/api/brain/code/files",
    async (request, reply) => {
      const q = filesQuery.safeParse(request.query);
      if (!q.success) return err400(reply, q.error.message);

      const db = activeDbFor(q.data.org_id);
      const conds = ["a.org_id = ?", "a.project_id = ?", "cs.file_path IS NOT NULL"];
      const params: (string | number)[] = [q.data.org_id, q.data.project_id];
      if (q.data.q) {
        conds.push("cs.file_path GLOB ?");
        params.push(`*${q.data.q}*`);
      }

      const rows = db
        .prepare(
          `SELECT cs.file_path AS file_path,
                  COUNT(DISTINCT cs.hash) AS snapshots,
                  COUNT(*) AS symbol_count,
                  MAX(a.ts) AS last_seen,
                  MIN(cs.language) AS language
             FROM code_symbols cs
             JOIN artifacts a ON a.hash = cs.hash
            WHERE ${conds.join(" AND ")}
         GROUP BY cs.file_path
         ORDER BY last_seen DESC
            LIMIT ?`,
        )
        .all(...params, q.data.limit) as Array<{
        file_path: string;
        snapshots: number;
        symbol_count: number;
        last_seen: number;
        language: string;
      }>;

      reply.send({ items: rows, total: rows.length });
    },
  );
}
