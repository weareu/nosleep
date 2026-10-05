/**
 * FTS-backed search over thoughts. Phase 2: lexical only via thoughts_fts.
 * Phase 3 extends with semantic cosine via sqlite-vec.
 *
 * `findThoughtsLexical` / `loadThoughtsForSearch` are the read primitives the
 * unified POST /api/brain/search orchestrator (retrieval/search.ts) fuses
 * with archive hits; `searchThoughts` is the thought-only endpoint built on
 * the same primitive. Org isolation + visibility are enforced here, once.
 */

import type Database from "better-sqlite3";
import { activeDbFor } from "../storage/active-db.js";
import { rowToThought } from "./capture.js";
import { markThoughtsRecalled } from "./recall.js";
import { thoughtVisibilityPredicate, type VisibilityOptions } from "./visibility.js";
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

type ThoughtDbRow = Parameters<typeof rowToThought>[0];

const THOUGHT_COLS = `t.id, t.org_id, t.project_id, t.content, t.metadata_json,
              t.thought_type, t.source_kind, t.source_refs_json,
              t.strategy_node_ref, t.created_at, t.updated_at, t.visibility`;

function escapeFts(q: string): string {
  const cleaned = q.replace(/"/g, " ").trim();
  return cleaned.length === 0 ? '""' : `"${cleaned}"`;
}

interface ThoughtScope extends VisibilityOptions {
  orgId: string;
  projectId: string;
  scope?: "project" | "org";
}

/** WHERE fragment (no leading AND) for org + scope + visibility on alias `t`. */
function scopeWhere(opts: ThoughtScope): { sql: string; params: string[] } {
  const conds = ["t.org_id = ?"];
  const params = [opts.orgId];
  if (opts.scope !== "org") {
    conds.push("t.project_id = ?");
    params.push(opts.projectId);
  }
  const vis = thoughtVisibilityPredicate("t", opts);
  if (vis) conds.push(vis);
  return { sql: conds.join(" AND "), params };
}

export interface LexicalThoughtHit {
  row: ThoughtDbRow;
  /** bm25 relevance, larger = better. */
  relevance: number;
}

/**
 * Lexical FTS over thoughts within org/scope/visibility. Read-only: does NOT
 * stamp recall (callers stamp only what they actually surface).
 */
export function findThoughtsLexical(
  db: Database.Database,
  opts: ThoughtScope & {
    query: string;
    limit: number;
    createdFrom?: number;
    createdTo?: number;
  },
): LexicalThoughtHit[] {
  const where = scopeWhere(opts);
  const extra: string[] = [];
  const extraParams: number[] = [];
  if (opts.createdFrom !== undefined) {
    extra.push("t.created_at >= ?");
    extraParams.push(opts.createdFrom);
  }
  if (opts.createdTo !== undefined) {
    extra.push("t.created_at <= ?");
    extraParams.push(opts.createdTo);
  }
  const extraSql = extra.length ? ` AND ${extra.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT ${THOUGHT_COLS}, bm25(thoughts_fts) AS bm25_score
         FROM thoughts_fts f
         JOIN thoughts t ON t.id = f.id
        WHERE f.content MATCH ?
          AND ${where.sql}${extraSql}
        ORDER BY bm25_score ASC
        LIMIT ?`,
    )
    .all(escapeFts(opts.query), ...where.params, ...extraParams, opts.limit) as Array<
    ThoughtDbRow & { bm25_score: number }
  >;
  return rows.map(({ bm25_score, ...row }) => ({ row, relevance: -bm25_score }));
}

/**
 * Load thoughts by id, keeping only those inside org/scope/visibility.
 * Used to hydrate semantic + lexical thought hits in the unified search.
 */
export function loadThoughtsForSearch(
  db: Database.Database,
  ids: readonly string[],
  opts: ThoughtScope,
): Map<string, ThoughtRow> {
  const out = new Map<string, ThoughtRow>();
  if (ids.length === 0) return out;
  const where = scopeWhere(opts);
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT ${THOUGHT_COLS} FROM thoughts t
        WHERE t.id IN (${placeholders}) AND ${where.sql}`,
    )
    .all(...ids, ...where.params) as ThoughtDbRow[];
  for (const r of rows) out.set(r.id, rowToThought(r));
  return out;
}

export function searchThoughts(
  opts: SearchThoughtsOptions,
): SearchThoughtsResult[] {
  const db = activeDbFor(opts.orgId);
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 100));
  const hits = findThoughtsLexical(db, { ...opts, limit });

  markThoughtsRecalled(db, hits.map((h) => h.row.id));

  return hits.map((h) => {
    const thought = rowToThought(h.row);
    return {
      thought,
      relevance: h.relevance,
      snippet: thought.content.slice(0, 240),
    };
  });
}
