/**
 * FTS-backed search over thoughts. Phase 2: lexical only via thoughts_fts.
 * Phase 3 extends with semantic cosine via sqlite-vec.
 */

import { activeDbFor } from "../storage/active-db.js";
import { rowToThought } from "./capture.js";
import { markThoughtsRecalled } from "./recall.js";
import { thoughtVisibilityPredicate } from "./visibility.js";
import type { ThoughtRow } from "./types.js";

export interface SearchThoughtsOptions {
  orgId: string;
  projectId: string;
  query: string;
  limit?: number;
  threshold?: number;
  scope?: "project" | "org";
  includeHidden?: boolean;
  /** Also return soft-archived thoughts (sleep-time consolidator). */
  includeArchived?: boolean;
}

export interface SearchThoughtsResult {
  thought: ThoughtRow;
  relevance: number;
  snippet: string;
}

function escapeFts(q: string): string {
  const cleaned = q.replace(/"/g, " ").trim();
  return cleaned.length === 0 ? '""' : `"${cleaned}"`;
}

export function searchThoughts(
  opts: SearchThoughtsOptions,
): SearchThoughtsResult[] {
  const db = activeDbFor(opts.orgId);
  const ftsQuery = escapeFts(opts.query);

  const scopeCond = opts.scope === "org" ? "t.org_id = ?" : "t.project_id = ?";
  const scopeParam = opts.scope === "org" ? opts.orgId : opts.projectId;

  const visPred = thoughtVisibilityPredicate("t", opts);
  const visCond = visPred ? ` AND ${visPred}` : "";
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 100));

  const rows = db
    .prepare(
      `SELECT t.id, t.org_id, t.project_id, t.content, t.metadata_json,
              t.thought_type, t.source_kind, t.source_refs_json,
              t.strategy_node_ref, t.created_at, t.updated_at, t.visibility,
              bm25(thoughts_fts) AS bm25_score
         FROM thoughts_fts f
         JOIN thoughts t ON t.id = f.id
        WHERE f.content MATCH ?
          AND t.org_id = ?
          AND ${scopeCond}
          ${visCond}
        ORDER BY bm25_score ASC
        LIMIT ?`,
    )
    .all(ftsQuery, opts.orgId, scopeParam, limit) as Array<
    Parameters<typeof rowToThought>[0] & { bm25_score: number }
  >;

  markThoughtsRecalled(db, rows.map((r) => r.id));

  return rows.map((row) => {
    const thought = rowToThought(row);
    return {
      thought,
      relevance: -row.bm25_score,
      snippet: thought.content.slice(0, 240),
    };
  });
}
