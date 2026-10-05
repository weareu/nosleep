/**
 * GET /api/brain/images — list image artifacts with optional pHash
 * clustering, scene_class filter, OCR full-text matching.
 *
 * Phase 5 minimum. Phase 9 polish layers swipe gallery + filmstrip.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { activeDbFor } from "../storage/active-db.js";

const querySchema = z.object({
  org_id: z.string().min(1),
  project_id: z.string().min(1),
  scene_class: z.string().optional(),
  ocr_query: z.string().optional(),
  cluster: z.enum(["none", "phash"]).default("none"),
  cluster_radius: z.coerce.number().int().min(0).max(32).default(8),
  limit: z.coerce.number().int().min(1).max(500).default(60),
  cursor: z.string().optional(),
});

interface ImageRow {
  hash: string;
  kind: string;
  ts: number;
  session_id: string | null;
  scene_class: string | null;
  caption: string | null;
  ocr_text: string | null;
  width: number | null;
  height: number | null;
  phash: bigint | null;
}

function err400(reply: FastifyReply, msg: string) {
  return reply.status(400).send({
    error: { code: "MISSING_FIELD", message: msg },
  });
}

function hamming64(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

interface PhashCluster {
  representative: string;
  hashes: string[];
}

function clusterByPhash(rows: ImageRow[], radius: number): PhashCluster[] {
  const clusters: PhashCluster[] = [];
  const claimed = new Set<string>();

  for (const row of rows) {
    if (claimed.has(row.hash) || row.phash === null) continue;
    const cluster: PhashCluster = {
      representative: row.hash,
      hashes: [row.hash],
    };
    claimed.add(row.hash);
    for (const other of rows) {
      if (claimed.has(other.hash) || other.phash === null) continue;
      if (hamming64(row.phash, other.phash) <= radius) {
        cluster.hashes.push(other.hash);
        claimed.add(other.hash);
      }
    }
    clusters.push(cluster);
  }

  // Append any unclaimed (no phash) as singleton clusters
  for (const row of rows) {
    if (!claimed.has(row.hash)) {
      clusters.push({ representative: row.hash, hashes: [row.hash] });
    }
  }

  return clusters;
}

export function registerBrainImageListRoutes(fastify: FastifyInstance): void {
  fastify.get<{ Querystring: z.input<typeof querySchema> }>(
    "/api/brain/images",
    async (request, reply) => {
      const q = querySchema.safeParse(request.query);
      if (!q.success) return err400(reply, q.error.message);

      const db = activeDbFor(q.data.org_id);
      const conds = [
        "a.kind GLOB 'media/image/*'",
        "a.org_id = ?",
        "a.project_id = ?",
      ];
      const params: (string | number)[] = [q.data.org_id, q.data.project_id];
      if (q.data.scene_class) {
        conds.push("img.scene_class = ?");
        params.push(q.data.scene_class);
      }
      if (q.data.ocr_query) {
        conds.push("img.ocr_text LIKE ?");
        params.push(`%${q.data.ocr_query}%`);
      }

      const rows = db
        .prepare(
          `SELECT a.hash AS hash, a.kind AS kind, a.ts AS ts, a.session_id AS session_id,
                  img.scene_class AS scene_class, img.caption AS caption,
                  img.ocr_text AS ocr_text, img.width AS width, img.height AS height,
                  img.phash AS phash
             FROM artifacts a
        LEFT JOIN image_features img ON img.hash = a.hash
            WHERE ${conds.join(" AND ")}
         ORDER BY a.ts DESC
            LIMIT ?`,
        )
        .safeIntegers(true)
        .all(...params, q.data.limit) as Array<ImageRow & { ts: bigint }>;

      // Re-coerce ts back to number for JSON friendliness; phash stays bigint
      // for lossless cluster math.
      const items = rows.map((r) => ({
        ...r,
        ts: Number(r.ts),
        phash: r.phash !== null ? r.phash.toString() : null,
      }));

      const clusters =
        q.data.cluster === "phash"
          ? clusterByPhash(rows, q.data.cluster_radius).map((c) => ({
              representative: c.representative,
              size: c.hashes.length,
              hashes: c.hashes,
            }))
          : null;

      reply.send({ items, clusters, total: items.length });
    },
  );
}
