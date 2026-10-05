/**
 * Hard-filter SQL WHERE builder. Takes a QuerySpec and produces a clause +
 * parameter list scoping candidates BEFORE any ranking.
 *
 * Phase 1 scope: project_id, kind_prefix, origin, actor, session_id,
 * temporal range, numeric predicates. Later phases add entities + scope='org'.
 */

import type { QuerySpecT, NumericPredicateT } from "./query-spec.js";

export interface WhereClause {
  sql: string;
  params: (string | number)[];
}

/**
 * Build the hard-filter WHERE for `artifacts` table.
 * Caller is responsible for prefixing with AND/WHERE as appropriate.
 */
export function buildArtifactsWhere(q: QuerySpecT): WhereClause {
  const conds: string[] = [];
  const params: (string | number)[] = [];

  // Org (always) + project (unless scope='org', which Phase 1 treats as project-only)
  conds.push("a.org_id = ?");
  params.push(q.org_id);

  if (q.scope === "project") {
    conds.push("a.project_id = ?");
    params.push(q.project_id);
  }

  // Facets
  if (q.facets?.kind_prefix?.length) {
    const kindClauses = q.facets.kind_prefix
      .map(() => "a.kind GLOB ?")
      .join(" OR ");
    conds.push(`(${kindClauses})`);
    for (const k of q.facets.kind_prefix) {
      params.push(k.endsWith("/") ? `${k}*` : `${k}*`);
    }
  }
  if (q.facets?.origin) {
    conds.push("a.origin_tool = ?");
    params.push(q.facets.origin);
  }
  if (q.facets?.session_id) {
    conds.push("a.session_id = ?");
    params.push(q.facets.session_id);
  }
  if (q.facets?.actor) {
    conds.push("a.actor = ?");
    params.push(q.facets.actor);
  }

  // Temporal range
  if (q.temporal?.from !== undefined) {
    conds.push("a.ts >= ?");
    params.push(q.temporal.from);
  }
  if (q.temporal?.to !== undefined) {
    conds.push("a.ts <= ?");
    params.push(q.temporal.to);
  }

  // Numeric predicates via artifact_num_meta join
  if (q.numeric && Object.keys(q.numeric).length > 0) {
    for (const [key, pred] of Object.entries(q.numeric)) {
      const { clause, values } = numericPredicateToClause(key, pred);
      conds.push(
        `a.hash IN (SELECT hash FROM artifact_num_meta WHERE key = ? AND ${clause})`,
      );
      params.push(key, ...values);
    }
  }

  return {
    sql: conds.join(" AND "),
    params,
  };
}

function numericPredicateToClause(
  key: string,
  pred: NumericPredicateT,
): { clause: string; values: number[] } {
  const c: string[] = [];
  const v: number[] = [];
  if (pred.gt !== undefined) {
    c.push("value > ?");
    v.push(pred.gt);
  }
  if (pred.lt !== undefined) {
    c.push("value < ?");
    v.push(pred.lt);
  }
  if (pred.eq !== undefined) {
    c.push("value = ?");
    v.push(pred.eq);
  }
  if (pred.ne !== undefined) {
    c.push("value <> ?");
    v.push(pred.ne);
  }
  if (pred.between) {
    c.push("value BETWEEN ? AND ?");
    v.push(pred.between[0], pred.between[1]);
  }
  // Unused to silence TS about unused param `key`
  void key;
  return {
    clause: c.length > 0 ? c.join(" AND ") : "1=1",
    values: v,
  };
}
