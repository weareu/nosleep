/**
 * Code-structural retriever. Matches query against code_symbols.symbol and
 * code_symbols.file_path, plus falls back to FTS for file content. Ranks by
 * symbol-exact > symbol-prefix > path-contains > language-kind priors.
 *
 * Returns [] when the query doesn't look code-y (no alphanum tokens) or
 * when code_symbols is empty.
 */

import type Database from "better-sqlite3";
import type { QuerySpecT } from "../query-spec.js";
import type { RetrieverResult } from "./bm25.js";
import { buildArtifactsWhere } from "../filters.js";

const SYMBOL_KIND_PRIORS: Record<string, number> = {
  function: 1.0,
  class: 0.9,
  interface: 0.85,
  enum: 0.8,
  type: 0.75,
  variable: 0.6,
  import: 0.4,
};

export function runCodeStructural(
  db: Database.Database,
  q: QuerySpecT,
  limit: number = 200,
): RetrieverResult[] {
  if (!q.text?.query) return [];
  const query = q.text.query.trim();
  if (query.length < 2) return [];

  const where = buildArtifactsWhere(q);

  // Tokenise the query — match any non-whitespace word-like piece.
  const tokens = query
    .split(/[^A-Za-z0-9_.:/-]+/)
    .filter((t) => t.length >= 2 && t.length <= 128);
  if (tokens.length === 0) return [];

  // Build parameterised matchers for each token; rank with CASE expressions
  // so exact + prefix beat substring, and kind prior scales accordingly.
  const matchSql: string[] = [];
  const matchParams: string[] = [];
  for (const t of tokens) {
    matchSql.push(`cs.symbol = ?`);
    matchParams.push(t);
    matchSql.push(`cs.symbol GLOB ?`);
    matchParams.push(`${t}*`);
    matchSql.push(`cs.file_path GLOB ?`);
    matchParams.push(`*${t}*`);
  }

  // kind prior lookup via CASE
  const kindCase = Object.entries(SYMBOL_KIND_PRIORS)
    .map(([k, v]) => `WHEN '${k}' THEN ${v}`)
    .join(" ");

  const sql = `
    SELECT a.hash AS hash,
           SUM(
             (CASE ${tokens.map(() => "WHEN cs.symbol = ? THEN 1.0").join(" ")} ELSE 0 END)
             + (CASE ${tokens.map(() => "WHEN cs.symbol GLOB ? THEN 0.6").join(" ")} ELSE 0 END)
             + (CASE ${tokens.map(() => "WHEN cs.file_path GLOB ? THEN 0.3").join(" ")} ELSE 0 END)
           ) * (CASE cs.symbol_kind ${kindCase} ELSE 0.5 END) AS score
      FROM code_symbols cs
      JOIN artifacts a ON a.hash = cs.hash
     WHERE (${matchSql.join(" OR ")})
       AND ${where.sql}
     GROUP BY a.hash
     HAVING score > 0
     ORDER BY score DESC
     LIMIT ?
  `;

  const scoreParams: string[] = [];
  for (const t of tokens) scoreParams.push(t);
  for (const t of tokens) scoreParams.push(`${t}*`);
  for (const t of tokens) scoreParams.push(`*${t}*`);

  try {
    const rows = db
      .prepare(sql)
      .all(
        ...scoreParams,
        ...matchParams,
        ...where.params,
        limit,
      ) as Array<{ hash: string; score: number }>;

    return rows.map((r, idx) => ({
      hash: r.hash,
      rank: idx + 1,
      raw_score: r.score,
      retriever: "code_structural",
    }));
  } catch {
    return [];
  }
}
