/**
 * GET /api/brain/artifacts/:hash — fetch an artifact with optional includes.
 * Includes (Phase 1): edges, ingest_event. Phase 2+ adds derived_thoughts.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { activeDbFor } from "../storage/active-db.js";
import {
  readCasBlob,
  CAS_COMPRESSION_MARKER,
} from "../storage/cas-blobs.js";

const orgQuery = z.object({
  org_id: z.string().min(1),
  include: z.string().optional(),
});

function parseIncludes(raw?: string): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

export function registerBrainArtifactRoutes(fastify: FastifyInstance): void {
  fastify.get<{
    Params: { hash: string };
    Querystring: { org_id: string; include?: string };
  }>("/api/brain/artifacts/:hash", async (request, reply) => {
    const q = orgQuery.safeParse(request.query);
    if (!q.success) {
      return reply.status(400).send({
        error: { code: "MISSING_FIELD", message: q.error.message },
      });
    }

    const { hash } = request.params;
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      return reply.status(400).send({
        error: { code: "MISSING_FIELD", message: "hash must be 64 hex chars" },
      });
    }

    const db = activeDbFor(q.data.org_id);
    const row = db
      .prepare(
        `SELECT hash, kind, ts, org_id, project_id, session_id, turn_ord,
                origin_tool, origin_version, actor,
                content, content_type, size, compression,
                schema_version, kind_specific_meta
           FROM artifacts
          WHERE hash = ? AND org_id = ?`,
      )
      .get(hash, q.data.org_id) as
      | {
          hash: string;
          kind: string;
          ts: number;
          org_id: string;
          project_id: string;
          session_id: string | null;
          turn_ord: number | null;
          origin_tool: string;
          origin_version: string | null;
          actor: string | null;
          content: Buffer | null;
          content_type: string | null;
          size: number;
          compression: string | null;
          schema_version: number;
          kind_specific_meta: string;
        }
      | undefined;

    if (!row) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: `artifact ${hash} not found` },
      });
    }

    const includes = parseIncludes(q.data.include);

    // Shape content for response — binary → base64, text → utf8
    const ct = (row.content_type ?? "").toLowerCase();
    const isBinary =
      ct.startsWith("image/") ||
      ct.startsWith("video/") ||
      ct.startsWith("audio/") ||
      ct === "application/octet-stream";
    // CAS resolution: when compression='cas', content column is NULL and
    // the real bytes live in data/brain/<org>/blobs/.
    let resolved: Buffer | null = row.content;
    if (!resolved && row.compression === CAS_COMPRESSION_MARKER) {
      try {
        resolved = readCasBlob(q.data.org_id, row.hash);
      } catch {
        resolved = null;
      }
    }
    const content = resolved
      ? isBinary
        ? resolved.toString("base64")
        : resolved.toString("utf8")
      : null;

    const out: Record<string, unknown> = {
      hash: row.hash,
      kind: row.kind,
      ts: row.ts,
      org_id: row.org_id,
      project_id: row.project_id,
      session_id: row.session_id,
      turn_ord: row.turn_ord,
      origin: {
        tool: row.origin_tool,
        version: row.origin_version,
        actor: row.actor,
      },
      content,
      content_encoding: isBinary ? "base64" : "utf8",
      content_type: row.content_type,
      size: row.size,
      schema_version: row.schema_version,
      kind_specific_meta: safeParse(row.kind_specific_meta),
    };

    if (includes.has("edges")) {
      const incoming = db
        .prepare(
          "SELECT from_hash, relation, scope FROM artifact_edges WHERE to_hash = ?",
        )
        .all(hash);
      const outgoing = db
        .prepare(
          "SELECT to_hash, relation, scope FROM artifact_edges WHERE from_hash = ?",
        )
        .all(hash);
      out.edges = { incoming, outgoing };
    }

    if (includes.has("ingest_event")) {
      const ev = db
        .prepare(
          `SELECT event_id, ts, source_tool, source_version, schema_version,
                  duplicate, enqueued_json, duration_ms
             FROM ingest_events WHERE artifact_hash = ?
             ORDER BY ts DESC LIMIT 1`,
        )
        .get(hash);
      out.ingest_event = ev ?? null;
    }

    reply.send(out);
  });
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
