/**
 * Phase 11 — backfill existing conversation turns into the thought layer.
 *
 * Iterates every conversation/turn/{user,assistant} artifact in an org that
 * doesn't already have an auto_from_artifact thought attached, and runs the
 * extractor on it. Throttled, parallel-capped, resumable. Triggered manually
 * via POST /api/admin/brain/auto-thoughts/run.
 */

import { activeDbFor } from "../storage/active-db.js";
import { runAutoThoughtExtraction } from "../extractors/auto-thought.js";

export interface AutoThoughtBackfillOptions {
  org_id: string;
  project_id?: string;
  limit?: number;
  /** Max concurrent Haiku calls. Each call is ~5-30s so keep low. */
  concurrency?: number;
}

export interface AutoThoughtBackfillResult {
  scanned: number;
  extracted: number;
  skipped: number;
  failed: number;
  duration_ms: number;
}

const DEFAULT_LIMIT = 500;
const DEFAULT_CONCURRENCY = 3;

export async function runAutoThoughtBackfill(
  opts: AutoThoughtBackfillOptions,
): Promise<AutoThoughtBackfillResult> {
  const started = performance.now();
  const db = activeDbFor(opts.org_id);
  // Defensive clamps — library callers can't bypass the route's Zod limits.
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), 1000);
  const concurrency = Math.min(
    Math.max(opts.concurrency ?? DEFAULT_CONCURRENCY, 1),
    8,
  );

  const params: (string | number)[] = [opts.org_id];
  let projectClause = "";
  if (opts.project_id) {
    projectClause = "AND a.project_id = ?";
    params.push(opts.project_id);
  }
  params.push(limit);

  const rows = db
    .prepare(
      `SELECT a.hash AS hash
         FROM artifacts a
        WHERE a.org_id = ?
          AND a.kind LIKE 'conversation/turn/%'
          ${projectClause}
          AND NOT EXISTS (
            SELECT 1 FROM thought_archive_refs r
              JOIN thoughts t ON t.id = r.thought_id
             WHERE r.archive_hash = a.hash
               AND t.source_kind = 'auto_from_artifact'
          )
        ORDER BY a.ts DESC
        LIMIT ?`,
    )
    .all(...params) as Array<{ hash: string }>;

  let extracted = 0;
  let skipped = 0;
  let failed = 0;

  // Simple bounded concurrency: process in batches of `concurrency`.
  for (let i = 0; i < rows.length; i += concurrency) {
    const batch = rows.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (r) => {
        try {
          const out = await runAutoThoughtExtraction({
            org_id: opts.org_id,
            artifact_hash: r.hash,
          });
          if (out.thought_id) return "ok";
          return "skip";
        } catch {
          return "fail";
        }
      }),
    );
    for (const r of results) {
      if (r === "ok") extracted += 1;
      else if (r === "skip") skipped += 1;
      else failed += 1;
    }
  }

  return {
    scanned: rows.length,
    extracted,
    skipped,
    failed,
    duration_ms: performance.now() - started,
  };
}
