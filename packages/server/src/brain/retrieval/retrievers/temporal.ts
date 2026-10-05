/**
 * Temporal retriever. Two modes:
 *   1. Range only — acts as a filter (already applied by buildArtifactsWhere).
 *   2. near_artifact — scores candidates by exp-decay around the pivot's ts.
 *
 * Returns empty result set when neither mode applies; caller fuses with
 * other retrievers via RRF (Phase 3).
 */

import type Database from "better-sqlite3";
import type { QuerySpecT } from "../query-spec.js";
import { buildArtifactsWhere } from "../filters.js";
import type { RetrieverResult } from "./bm25.js";

/**
 * Half-life for temporal decay. Tunable per intent in Phase 7; Phase 1
 * uses a sensible default.
 */
const DEFAULT_HALF_LIFE_SEC = 1800; // 30 minutes

export function runTemporal(
  db: Database.Database,
  q: QuerySpecT,
  limit: number = 200,
): RetrieverResult[] {
  if (!q.temporal?.near_artifact) return [];

  // Resolve pivot ts from the referenced artifact.
  const pivot = db
    .prepare("SELECT ts FROM artifacts WHERE hash = ?")
    .get(q.temporal.near_artifact) as { ts: number } | undefined;

  if (!pivot) return [];

  const where = buildArtifactsWhere(q);
  const windowSec = q.temporal.window_sec ?? DEFAULT_HALF_LIFE_SEC * 4;
  const halfLife = DEFAULT_HALF_LIFE_SEC;

  const sql = `
    SELECT a.hash AS hash,
           a.ts AS ts,
           ABS(a.ts - ?) AS dt
      FROM artifacts a
     WHERE ${where.sql}
       AND ABS(a.ts - ?) <= ?
       AND a.hash != ?
     ORDER BY dt ASC
     LIMIT ?
  `;

  const rows = db
    .prepare(sql)
    .all(
      pivot.ts,
      ...where.params,
      pivot.ts,
      windowSec,
      q.temporal.near_artifact,
      limit,
    ) as { hash: string; ts: number; dt: number }[];

  return rows.map((r, idx) => ({
    hash: r.hash,
    rank: idx + 1,
    raw_score: Math.exp(-r.dt / halfLife),
    retriever: "temporal",
  }));
}
