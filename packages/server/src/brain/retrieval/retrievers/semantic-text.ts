/**
 * Semantic text retriever. Embeds the query, queries vec_text via sqlite-vec
 * MATCH, joins back through vec_text_map to recover the source hash
 * (artifact) or id (thought) + project_id for hard-filter intersection.
 *
 * Returns empty results when the vec extension is unavailable or no provider
 * is configured.
 *
 * Phase 9: optional fan-out across sealed files. When `files` is provided,
 * the retriever runs one MATCH per file (each schema has its own vec_text)
 * and collapses by hash keeping the smallest distance.
 */

import type Database from "better-sqlite3";
import type { QuerySpecT } from "../query-spec.js";
import type { RetrieverResult } from "./bm25.js";
import { isVecLoaded } from "../../storage/vec-loader.js";
import { getEmbedProvider } from "../../extractors/embed-provider.js";
import type { SelectedFile } from "../../storage/file-selection.js";
import { thoughtVisibilityPredicate } from "../../thoughts/visibility.js";

export async function runSemanticText(
  db: Database.Database,
  q: QuerySpecT,
  limit: number = 200,
  files?: SelectedFile[],
): Promise<RetrieverResult[]> {
  if (!q.text?.query) return [];
  if (!isVecLoaded(db)) return [];

  const provider = getEmbedProvider();
  let queryEmbedding: Float32Array;
  try {
    queryEmbedding = await provider.embed(q.text.query);
  } catch {
    return [];
  }

  const embBuf = Buffer.from(queryEmbedding.buffer);
  const fanout = files && files.length > 0 ? files : [
    { alias: "main", path: "", kind: "active" as const, file_name: "active.db", ts_from: null, ts_to: null },
  ];

  // sqlite-vec returns global nearest neighbours within each vec_text
  // table. We over-fetch per file to give the project filter room to drop
  // out-of-scope rows.
  const overFetchPerFile = Math.min(limit * 5, 1000);

  // Per-file branch:
  //   SELECT m.hash, h.distance
  //     FROM (SELECT rowid, distance FROM <s>.vec_text WHERE embedding MATCH ? AND k = ?) h
  //     JOIN <s>.vec_text_map m ON m.rowid = h.rowid
  //    WHERE (m.referrer_kind = 'artifact' AND m.hash IN (SELECT hash FROM <s>.artifacts WHERE org_id = ? [AND project_id = ?]))
  //       OR (m.referrer_kind = 'thought'  AND m.hash IN (SELECT id FROM <s>.thoughts WHERE org_id = ? [AND project_id = ?] AND visibility = 'active'))
  // UNION ALL across files.
  const branches: string[] = [];
  const params: (string | number | Buffer)[] = [];

  // Archived thoughts are excluded unless the caller opts in; merged-away
  // thoughts are never semantic hits (their survivor carries the content).
  const thoughtVis = thoughtVisibilityPredicate("t", {
    includeArchived: q.include_archived,
  });

  for (const f of fanout) {
    const s = f.alias;
    branches.push(`
      SELECT m.hash AS hash, m.referrer_kind AS referrer_kind, h.distance AS distance
        FROM (SELECT rowid, distance FROM ${s}.vec_text WHERE embedding MATCH ? AND k = ?) h
        JOIN ${s}.vec_text_map m ON m.rowid = h.rowid
       WHERE (
         (m.referrer_kind = 'artifact'
            AND m.hash IN (
              SELECT a.hash FROM ${s}.artifacts a
               WHERE a.org_id = ?
                 ${q.scope === "project" ? "AND a.project_id = ?" : ""}
            ))
          OR
         (m.referrer_kind = 'thought'
            AND m.hash IN (
              SELECT t.id FROM ${s}.thoughts t
               WHERE t.org_id = ?
                 ${q.scope === "project" ? "AND t.project_id = ?" : ""}
                 AND ${thoughtVis}
            ))
       )
    `);
    params.push(embBuf, overFetchPerFile, q.org_id);
    if (q.scope === "project") params.push(q.project_id);
    params.push(q.org_id);
    if (q.scope === "project") params.push(q.project_id);
  }

  const sql = `
    WITH all_hits AS (${branches.join(" UNION ALL ")})
    SELECT hash, MIN(distance) AS distance
      FROM all_hits
     GROUP BY hash
     ORDER BY distance ASC
     LIMIT ?
  `;
  params.push(limit);

  try {
    const rows = db.prepare(sql).all(...params) as Array<{
      hash: string;
      distance: number;
    }>;

    return rows.map((r, idx) => ({
      hash: r.hash,
      rank: idx + 1,
      raw_score: 1 - r.distance, // cosine similarity ≈ 1 - distance for normalised vecs
      retriever: "semantic_text",
    }));
  } catch {
    return [];
  }
}
