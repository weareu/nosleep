/**
 * Phase 22-E — near-duplicate thought detector. For each thought with an
 * embedding, find its nearest neighbour via sqlite-vec's KNN MATCH and
 * propose a merge if cosine similarity ≥ threshold (default 0.92).
 *
 * Idempotent via the (from, to) UNIQUE on thought_merge_proposals. Cheap
 * — each thought triggers one KNN over the org's vec_text. Runs daily from
 * jobs/maintenance.ts (proposals only — never auto-merges) and on demand via
 * POST /api/brain/admin/thought-merge-proposals/run.
 *
 * Lint-pass cousin to the entity merge proposer. The merge-queue admin
 * UI surfaces both kinds.
 */

import { nanoid } from "nanoid";
import { activeDbFor } from "../storage/active-db.js";

export interface ThoughtDedupOptions {
  org_id: string;
  project_id?: string;
  /** Minimum cosine similarity to propose a merge. Default 0.92. */
  threshold?: number;
  /** How many thoughts to scan in one run. Bounded so a manual run
   *  stays well under a minute. */
  limit?: number;
}

export interface ThoughtDedupResult {
  scanned: number;
  proposed: number;
  duplicates: number;
  failed: number;
  duration_ms: number;
}

const DEFAULT_LIMIT = 500;
const DEFAULT_THRESHOLD = 0.92;

/** KNN breadth. vec_text holds artifact chunks too, so k must leave room for
 *  thought neighbours after the referrer_kind filter (k=3 mostly returned
 *  self + artifacts). */
const KNN_K = 16;
/** Yield to the event loop every N scanned thoughts — each KNN is a
 *  brute-force scan, and 500 of them back-to-back can stall the server. */
const YIELD_EVERY = 10;

export async function runThoughtDedup(opts: ThoughtDedupOptions): Promise<ThoughtDedupResult> {
  const started = performance.now();
  const db = activeDbFor(opts.org_id);
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, 2000));
  const threshold = Math.max(0.5, Math.min(opts.threshold ?? DEFAULT_THRESHOLD, 0.999));

  let scanned = 0;
  let proposed = 0;
  let duplicates = 0;
  let failed = 0;

  // Iterate thoughts that have an embedding (vec_text_map row) and a
  // non-empty content. Most thoughts have chunk_ord=0 — pick that
  // representative row for the comparison.
  const params: (string | number)[] = [opts.org_id];
  let projectClause = "";
  if (opts.project_id) {
    projectClause = "AND t.project_id = ?";
    params.push(opts.project_id);
  }
  params.push(limit);

  const rows = db
    .prepare(
      `SELECT t.id AS thought_id, t.project_id, m.rowid AS vec_rowid, v.embedding AS embedding
         FROM vec_text_map m
         JOIN thoughts t ON t.id = m.hash AND t.org_id = ?
         JOIN vec_text v ON v.rowid = m.rowid
        WHERE m.referrer_kind = 'thought' AND m.chunk_ord = 0
          AND t.visibility = 'active'
          ${projectClause}
        ORDER BY t.created_at DESC
        LIMIT ?`,
    )
    .all(...params) as Array<{
      thought_id: string;
      project_id: string;
      vec_rowid: number;
      embedding: Buffer;
    }>;

  // Neighbours must be live thoughts in this org — archived/merged thoughts
  // are already out of retrieval, proposing them is noise.
  const neighbourQuery = db.prepare(
    `SELECT m.hash AS neighbour_id, v.distance AS dist
       FROM vec_text v
       JOIN vec_text_map m ON m.rowid = v.rowid
       JOIN thoughts nt ON nt.id = m.hash AND nt.org_id = ? AND nt.visibility = 'active'
      WHERE v.embedding MATCH ? AND k = ${KNN_K}
        AND m.referrer_kind = 'thought'
        AND m.hash != ?
      ORDER BY v.distance ASC`,
  );

  // Pre-cache the from-side proposer query
  const insertProposal = db.prepare(
    `INSERT OR IGNORE INTO thought_merge_proposals
      (id, org_id, project_id, from_thought_id, to_thought_id, similarity, rationale, proposer, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const row of rows) {
    if (scanned > 0 && scanned % YIELD_EVERY === 0) {
      await new Promise((res) => setImmediate(res));
    }
    scanned += 1;
    try {
      // KNN search via vec_text MATCH — returns top-K by distance.
      const neighbours = neighbourQuery
        .all(opts.org_id, row.embedding, row.thought_id) as Array<{
          neighbour_id: string;
          dist: number;
        }>;

      for (const nb of neighbours) {
        // cosine distance → similarity. sqlite-vec returns L2 distance
        // for vec0 default; embeddings here are normalized so cosine
        // similarity ≈ 1 − dist²/2 (when L2 ≤ √2).
        const cosSim = 1 - (nb.dist * nb.dist) / 2;
        if (cosSim < threshold) break; // results are sorted ascending dist

        // Order the pair so (from < to) gives a stable unique key.
        const [a, b] =
          row.thought_id < nb.neighbour_id
            ? [row.thought_id, nb.neighbour_id]
            : [nb.neighbour_id, row.thought_id];
        const id = `tmp_${nanoid(10)}`;
        const result = insertProposal.run(
          id,
          opts.org_id,
          row.project_id,
          a,
          b,
          cosSim,
          `cosine_sim=${cosSim.toFixed(4)} from embedding KNN`,
          "embedding_dedup",
          Math.floor(Date.now() / 1000),
        );
        if (result.changes > 0) proposed += 1;
        else duplicates += 1;
      }
    } catch {
      failed += 1;
    }
  }

  return {
    scanned,
    proposed,
    duplicates,
    failed,
    duration_ms: performance.now() - started,
  };
}
