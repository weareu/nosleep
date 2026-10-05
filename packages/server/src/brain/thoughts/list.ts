/**
 * List recent thoughts with optional filters. Tool shape inspired by Open Brain's list_thoughts
 * tool with project scoping added.
 */

import { activeDbFor } from "../storage/active-db.js";
import { rowToThought } from "./capture.js";
import type { ThoughtRow } from "./types.js";
import { thoughtVisibilityPredicate } from "./visibility.js";

export interface ListThoughtsOptions {
  orgId: string;
  projectId: string;
  type?: string;
  topic?: string;
  person?: string;
  days?: number;
  limit?: number;
  includeHidden?: boolean;
  /** Also return soft-archived thoughts (sleep-time consolidator). */
  includeArchived?: boolean;
}

export function listThoughts(opts: ListThoughtsOptions): ThoughtRow[] {
  const db = activeDbFor(opts.orgId);

  const conds = ["t.org_id = ?", "t.project_id = ?"];
  const params: (string | number)[] = [opts.orgId, opts.projectId];

  const visPred = thoughtVisibilityPredicate("t", opts);
  if (visPred) conds.push(visPred);
  if (opts.type) {
    conds.push("t.thought_type = ?");
    params.push(opts.type);
  }
  if (opts.topic) {
    conds.push("json_extract(t.metadata_json, '$.topics') LIKE ?");
    params.push(`%${opts.topic}%`);
  }
  if (opts.person) {
    conds.push("json_extract(t.metadata_json, '$.people') LIKE ?");
    params.push(`%${opts.person}%`);
  }
  if (opts.days !== undefined) {
    const since = Math.floor(Date.now() / 1000) - opts.days * 86400;
    conds.push("t.created_at >= ?");
    params.push(since);
  }

  const limit = Math.max(1, Math.min(opts.limit ?? 20, 500));

  const rows = db
    .prepare(
      `SELECT id, org_id, project_id, content, metadata_json, thought_type,
              source_kind, source_refs_json, strategy_node_ref,
              created_at, updated_at, visibility
         FROM thoughts t
        WHERE ${conds.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(...params, limit) as Parameters<typeof rowToThought>[0][];

  return rows.map(rowToThought);
}
