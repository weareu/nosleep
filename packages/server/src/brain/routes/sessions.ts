/**
 * GET /api/brain/sessions/:session_id/artifacts — paginated session replay.
 *
 * Cursor-based pagination via (ts, hash) tuple. Newer artifacts first by
 * default; reverse=true returns oldest first.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { activeDbFor } from "../storage/active-db.js";

const querySchema = z.object({
  org_id: z.string().min(1),
  since: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
  order: z.enum(["asc", "desc"]).default("asc"),
});

function encodeCursor(ts: number, hash: string): string {
  return Buffer.from(`${ts}|${hash}`).toString("base64url");
}

function decodeCursor(cursor: string): { ts: number; hash: string } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const [tsStr, hash] = raw.split("|");
    const ts = Number(tsStr);
    if (!Number.isFinite(ts) || !hash) return null;
    return { ts, hash };
  } catch {
    return null;
  }
}

export function registerBrainSessionRoutes(fastify: FastifyInstance): void {
  fastify.get<{
    Params: { session_id: string };
    Querystring: z.input<typeof querySchema>;
  }>("/api/brain/sessions/:session_id/artifacts", async (request, reply) => {
    const q = querySchema.safeParse(request.query);
    if (!q.success) {
      return reply.status(400).send({
        error: { code: "MISSING_FIELD", message: q.error.message },
      });
    }

    const { session_id } = request.params;
    const db = activeDbFor(q.data.org_id);

    const cursorTuple = q.data.cursor ? decodeCursor(q.data.cursor) : null;

    const orderClause =
      q.data.order === "asc" ? "a.ts ASC, a.hash ASC" : "a.ts DESC, a.hash DESC";
    const cmpOp = q.data.order === "asc" ? ">" : "<";

    const conds = ["a.session_id = ?", "a.org_id = ?"];
    const params: (string | number)[] = [session_id, q.data.org_id];

    if (q.data.since !== undefined) {
      conds.push("a.ts >= ?");
      params.push(q.data.since);
    }

    if (cursorTuple) {
      conds.push(
        `(a.ts ${cmpOp} ? OR (a.ts = ? AND a.hash ${cmpOp} ?))`,
      );
      params.push(cursorTuple.ts, cursorTuple.ts, cursorTuple.hash);
    }

    const sql = `
      SELECT a.hash, a.kind, a.ts, a.turn_ord, a.origin_tool, a.actor,
             a.kind_specific_meta, a.size,
             (SELECT substr(text, 1, 240) FROM artifacts_fts_src WHERE hash = a.hash) AS snippet
        FROM artifacts a
       WHERE ${conds.join(" AND ")}
       ORDER BY ${orderClause}
       LIMIT ?
    `;

    const rows = db.prepare(sql).all(...params, q.data.limit) as {
      hash: string;
      kind: string;
      ts: number;
      turn_ord: number | null;
      origin_tool: string;
      actor: string | null;
      kind_specific_meta: string;
      size: number;
      snippet: string | null;
    }[];

    const nextCursor =
      rows.length === q.data.limit
        ? encodeCursor(rows[rows.length - 1].ts, rows[rows.length - 1].hash)
        : null;

    reply.send({
      session_id,
      items: rows.map((r) => ({
        hash: r.hash,
        kind: r.kind,
        ts: r.ts,
        turn_ord: r.turn_ord,
        origin_tool: r.origin_tool,
        actor: r.actor,
        size: r.size,
        snippet: r.snippet,
        kind_specific_meta: safeParse(r.kind_specific_meta),
      })),
      cursor: nextCursor,
    });
  });
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
