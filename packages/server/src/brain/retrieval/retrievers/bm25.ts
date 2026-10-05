/**
 * Lexical retriever. Runs FTS5 MATCH against artifacts_fts, returns top-K
 * by bm25() score within the hard-filter candidate pool.
 *
 * FTS5's bm25() returns LOWER = MORE RELEVANT. We invert for caller clarity.
 *
 * Phase 9: optional fan-out across sealed files. When `files` includes
 * sealed entries, the retriever issues one MATCH per file under UNION ALL,
 * deduping by hash and keeping the best (smallest) bm25 score.
 */

import type Database from "better-sqlite3";
import type { QuerySpecT } from "../query-spec.js";
import { buildArtifactsWhere } from "../filters.js";
import type { SelectedFile } from "../../storage/file-selection.js";

export interface RetrieverResult {
  hash: string;
  rank: number;
  raw_score: number;
  retriever: string;
}

/**
 * Escape FTS5 reserved characters in a user-provided query string.
 * We accept raw user text; FTS5 has special syntax (AND, OR, NOT, NEAR,
 * column filters, prefix stars, quoted phrases). For Phase 1 we wrap the
 * user query in a phrase-match to avoid injecting syntax.
 */
function escapeForFts(query: string): string {
  // Strip double-quotes to avoid escaping headaches, then wrap in phrase quotes.
  const cleaned = query.replace(/"/g, " ").trim();
  if (cleaned.length === 0) return '""';
  return `"${cleaned}"`;
}

/**
 * Run BM25 retriever. Returns top-K candidates ordered by relevance.
 *
 * `files` is optional. When omitted, queries `main` (active.db) only —
 * matches Phase 1 behavior. When provided, fans out across each schema
 * (`main`, `s0`, `s1`, ...).
 */
export function runBm25(
  db: Database.Database,
  q: QuerySpecT,
  limit: number = 200,
  files?: SelectedFile[],
): RetrieverResult[] {
  if (!q.text?.query) return [];

  const ftsQuery = escapeForFts(q.text.query);
  const fanout = files && files.length > 0 ? files : [
    { alias: "main", path: "", kind: "active" as const, file_name: "active.db", ts_from: null, ts_to: null },
  ];

  // Each branch:
  //   SELECT a.hash, bm25(<schema>.artifacts_fts) AS s
  //     FROM <schema>.artifacts_fts
  //     JOIN <schema>.artifacts a ON a.hash = <schema>.artifacts_fts.hash
  //    WHERE <schema>.artifacts_fts.text MATCH ? AND <where ON a>
  //    ORDER BY s ASC LIMIT ?
  // UNION ALL across all files, then dedupe by hash keeping MIN score.
  const branches: string[] = [];
  const params: (string | number)[] = [];
  const perFileLimit = Math.max(50, Math.ceil(limit / fanout.length) * 2);

  // FTS5 exposes the bm25 score as a `rank` virtual column. We use that
  // (instead of the bm25() function) because column access supports
  // schema-qualified paths (`s0.artifacts_fts.rank`), whereas bm25() does
  // not accept schema-prefixed table names.
  for (const f of fanout) {
    const s = f.alias;
    const where = buildArtifactsWhere(q, s);
    branches.push(`
      SELECT * FROM (
        SELECT a.hash AS hash, ${s}.artifacts_fts.rank AS bm25_score
          FROM ${s}.artifacts_fts
          JOIN ${s}.artifacts a ON a.hash = ${s}.artifacts_fts.hash
         WHERE ${s}.artifacts_fts.text MATCH ?
           AND ${where.sql}
         ORDER BY bm25_score ASC
         LIMIT ?
      )
    `);
    params.push(ftsQuery, ...where.params, perFileLimit);
  }

  const sql = `
    WITH all_hits AS (${branches.join(" UNION ALL ")})
    SELECT hash, MIN(bm25_score) AS bm25_score
      FROM all_hits
     GROUP BY hash
     ORDER BY bm25_score ASC
     LIMIT ?
  `;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as {
    hash: string;
    bm25_score: number;
  }[];

  return rows.map((r, idx) => ({
    hash: r.hash,
    rank: idx + 1,
    // bm25() returns negative-space; take absolute + invert so larger = better
    raw_score: -r.bm25_score,
    retriever: "bm25",
  }));
}
