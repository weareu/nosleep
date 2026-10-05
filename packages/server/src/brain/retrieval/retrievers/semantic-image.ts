/**
 * Semantic image retriever — CLIP cosine search over vec_clip. Requires a
 * CLIP embedding supplied by the caller (the brain API doesn't yet run CLIP
 * at query time; clients pre-embed and pass vector_ref, or reference an
 * image artifact whose CLIP vector we already have).
 *
 * Returns [] when the vec extension isn't loaded, vec_clip is empty, or no
 * anchor is provided.
 */

import type Database from "better-sqlite3";
import type { QuerySpecT } from "../query-spec.js";
import type { RetrieverResult } from "./bm25.js";
import { isVecLoaded } from "../../storage/vec-loader.js";
import { buildArtifactsWhere } from "../filters.js";

export async function runSemanticImage(
  db: Database.Database,
  q: QuerySpecT,
  limit: number = 100,
): Promise<RetrieverResult[]> {
  if (!q.image?.vector_ref) return [];
  if (!isVecLoaded(db)) return [];

  // Look up the anchor image's CLIP vector via vec_clip_map's rowid
  const anchor = db
    .prepare(`SELECT rowid FROM vec_clip_map WHERE hash = ? LIMIT 1`)
    .get(q.image.vector_ref) as { rowid: number } | undefined;
  if (!anchor) return [];

  // Read anchor vector from vec0. sqlite-vec returns the embedding as a blob
  // we could match with MATCH '?', but a simpler path is: use the anchor's
  // vec_clip row directly via WHERE rowid=? MATCH? (not supported — so we
  // fetch the vector first).
  const vecRow = db
    .prepare(`SELECT embedding FROM vec_clip WHERE rowid = ?`)
    .get(anchor.rowid) as { embedding: Buffer } | undefined;
  if (!vecRow) return [];

  const where = buildArtifactsWhere(q);

  try {
    const rows = db
      .prepare(
        `WITH hits AS (
           SELECT rowid, distance FROM vec_clip
            WHERE embedding MATCH ? AND k = ?
         )
         SELECT m.hash AS hash, h.distance AS distance
           FROM hits h
           JOIN vec_clip_map m ON m.rowid = h.rowid
           JOIN artifacts a ON a.hash = m.hash
          WHERE m.hash != ?
            AND ${where.sql}
          ORDER BY h.distance ASC
          LIMIT ?`,
      )
      .all(
        vecRow.embedding,
        limit * 3,
        q.image.vector_ref,
        ...where.params,
        limit,
      ) as Array<{ hash: string; distance: number }>;

    return rows.map((r, idx) => ({
      hash: r.hash,
      rank: idx + 1,
      raw_score: 1 - r.distance,
      retriever: "semantic_image",
    }));
  } catch {
    return [];
  }
}
