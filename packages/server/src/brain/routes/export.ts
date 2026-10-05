/**
 * Export endpoints — let an external tool (or the user) pull a session or
 * thought out of the brain in a portable format.
 *
 *   GET /api/brain/sessions/:session_id/export?org_id=&format=json|md|jsonl
 *   GET /api/brain/thoughts/:thought_id/export?org_id=&format=json|md
 *
 * Defaults to JSON. Markdown is intended for piping into a notes app;
 * JSONL streams one artifact per line for downstream pipelines.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { activeDbFor } from "../storage/active-db.js";
import { getThought } from "../thoughts/get.js";

const sessionExportQuery = z.object({
  org_id: z.string().min(1),
  format: z.enum(["json", "md", "jsonl"]).default("json"),
  limit: z.coerce.number().int().min(1).max(5000).default(2000),
});

const thoughtExportQuery = z.object({
  org_id: z.string().min(1),
  format: z.enum(["json", "md"]).default("json"),
});

interface SessionArtifactRow {
  hash: string;
  kind: string;
  ts: number;
  turn_ord: number | null;
  origin_tool: string;
  actor: string | null;
  content: Buffer | null;
  content_type: string | null;
  size: number;
  text: string | null;
  kind_specific_meta: string | null;
}

function decodeArtifactContent(row: SessionArtifactRow): string | null {
  if (row.text) return row.text;
  if (!row.content) return null;
  const ct = (row.content_type ?? "").toLowerCase();
  if (
    ct.startsWith("image/") ||
    ct.startsWith("video/") ||
    ct.startsWith("audio/") ||
    ct.includes("octet-stream")
  ) {
    return null;
  }
  try {
    return row.content.toString("utf8");
  } catch {
    return null;
  }
}

function safeParse(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function err400(reply: FastifyReply, msg: string) {
  return reply
    .status(400)
    .send({ error: { code: "MISSING_FIELD", message: msg } });
}

export function registerBrainExportRoutes(fastify: FastifyInstance): void {
  fastify.get<{
    Params: { session_id: string };
    Querystring: z.input<typeof sessionExportQuery>;
  }>("/api/brain/sessions/:session_id/export", async (request, reply) => {
    const q = sessionExportQuery.safeParse(request.query);
    if (!q.success) return err400(reply, q.error.message);

    const { session_id } = request.params;
    const db = activeDbFor(q.data.org_id);

    const rows = db
      .prepare(
        `SELECT a.hash, a.kind, a.ts, a.turn_ord, a.origin_tool, a.actor,
                a.content, a.content_type, a.size, a.kind_specific_meta,
                (SELECT text FROM artifacts_fts_src WHERE hash = a.hash) AS text
           FROM artifacts a
          WHERE a.session_id = ? AND a.org_id = ?
          ORDER BY a.ts ASC, a.hash ASC
          LIMIT ?`,
      )
      .all(session_id, q.data.org_id, q.data.limit) as SessionArtifactRow[];

    if (q.data.format === "md") {
      const lines: string[] = [];
      lines.push(`# Session ${session_id}`);
      lines.push("");
      lines.push(`_Exported ${new Date().toISOString()} · ${rows.length} artifacts_`);
      lines.push("");
      for (const r of rows) {
        const ts = new Date(r.ts * 1000).toISOString();
        lines.push(`## ${r.kind}  · ${ts}`);
        lines.push("");
        lines.push(
          `*hash:* \`${r.hash}\` · *origin:* ${r.origin_tool}${r.actor ? ` (${r.actor})` : ""}`,
        );
        lines.push("");
        const body = decodeArtifactContent(r);
        if (body) {
          lines.push("```");
          lines.push(body.slice(0, 8000));
          lines.push("```");
        } else {
          lines.push(`_[binary, ${r.size} bytes, ${r.content_type ?? "unknown"}]_`);
        }
        lines.push("");
      }
      reply.header("content-type", "text/markdown; charset=utf-8");
      reply.header(
        "content-disposition",
        `attachment; filename="session-${session_id}.md"`,
      );
      return reply.send(lines.join("\n"));
    }

    if (q.data.format === "jsonl") {
      const chunks = rows.map((r) =>
        JSON.stringify({
          hash: r.hash,
          kind: r.kind,
          ts: r.ts,
          turn_ord: r.turn_ord,
          origin_tool: r.origin_tool,
          actor: r.actor,
          size: r.size,
          content_type: r.content_type,
          content: decodeArtifactContent(r),
          kind_specific_meta: safeParse(r.kind_specific_meta),
        }),
      );
      reply.header("content-type", "application/x-ndjson; charset=utf-8");
      reply.header(
        "content-disposition",
        `attachment; filename="session-${session_id}.jsonl"`,
      );
      return reply.send(chunks.join("\n") + (chunks.length > 0 ? "\n" : ""));
    }

    // JSON
    reply.send({
      session_id,
      org_id: q.data.org_id,
      exported_at: Math.floor(Date.now() / 1000),
      artifact_count: rows.length,
      artifacts: rows.map((r) => ({
        hash: r.hash,
        kind: r.kind,
        ts: r.ts,
        turn_ord: r.turn_ord,
        origin_tool: r.origin_tool,
        actor: r.actor,
        size: r.size,
        content_type: r.content_type,
        content: decodeArtifactContent(r),
        kind_specific_meta: safeParse(r.kind_specific_meta),
      })),
    });
  });

  fastify.get<{
    Params: { thought_id: string };
    Querystring: z.input<typeof thoughtExportQuery>;
  }>("/api/brain/thoughts/:thought_id/export", async (request, reply) => {
    const q = thoughtExportQuery.safeParse(request.query);
    if (!q.success) return err400(reply, q.error.message);

    const { thought_id } = request.params;
    const detail = getThought(
      q.data.org_id,
      thought_id,
      new Set(["refs"]),
    );
    if (!detail) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "thought not found" },
      });
    }

    if (q.data.format === "md") {
      const lines: string[] = [];
      lines.push(`# ${detail.thought_type ?? "thought"}: ${thought_id}`);
      lines.push("");
      lines.push(detail.content);
      lines.push("");
      lines.push(
        `_captured ${new Date(detail.created_at * 1000).toISOString()} · project ${detail.project_id}_`,
      );
      lines.push("");
      if (detail.archive_refs?.length) {
        lines.push("## Linked archive artifacts");
        for (const r of detail.archive_refs) {
          lines.push(`- \`${r.archive_hash}\` (${r.relation})`);
        }
        lines.push("");
      }
      if (detail.thought_refs?.outgoing.length) {
        lines.push("## Linked thoughts");
        for (const r of detail.thought_refs.outgoing) {
          lines.push(`- ${r.relation} → ${r.to_thought_id}`);
        }
        lines.push("");
      }
      if (detail.entity_refs?.length) {
        lines.push("## Entities");
        for (const r of detail.entity_refs) {
          lines.push(`- ${r.relation} ${r.entity_id}`);
        }
        lines.push("");
      }
      reply.header("content-type", "text/markdown; charset=utf-8");
      reply.header(
        "content-disposition",
        `attachment; filename="thought-${thought_id}.md"`,
      );
      return reply.send(lines.join("\n"));
    }

    reply.send({
      thought: detail,
      exported_at: Math.floor(Date.now() / 1000),
    });
  });
}
