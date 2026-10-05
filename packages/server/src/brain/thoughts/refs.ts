/**
 * Manual thought→thought linking. Callers can add edges with a typed
 * relation (refines, supersedes, contradicts, related_to, etc.). Edges are
 * append-only via the trg_no_update_trefs trigger.
 */

import { activeDbFor } from "../storage/active-db.js";

export type ThoughtRefRelation =
  | "refines"
  | "supersedes"
  | "contradicts"
  | "continues"
  | "related_to"
  | "duplicate_of"
  | "answers"
  | "asks_about"
  | "derives_from_thought";

export interface AddThoughtRefRequest {
  from_thought_id: string;
  to_thought_id: string;
  relation: ThoughtRefRelation;
  origin?: "user_linked" | "llm_suggested" | "derived_cooccurrence" | "skill_generated";
  org_id: string;
}

export interface AddThoughtRefResult {
  created: boolean;
  project_id: string;
  scope: "intra_project" | "cross_project";
}

export class ThoughtRefError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "ThoughtRefError";
  }
}

export function addThoughtRef(req: AddThoughtRefRequest): AddThoughtRefResult {
  if (req.from_thought_id === req.to_thought_id) {
    throw new ThoughtRefError("SELF_REF", "from and to must be different thoughts");
  }

  const db = activeDbFor(req.org_id);

  const pair = db
    .prepare(
      `SELECT
         (SELECT project_id FROM thoughts WHERE id = ? AND org_id = ?) AS from_proj,
         (SELECT project_id FROM thoughts WHERE id = ? AND org_id = ?) AS to_proj`,
    )
    .get(
      req.from_thought_id,
      req.org_id,
      req.to_thought_id,
      req.org_id,
    ) as { from_proj: string | null; to_proj: string | null };

  if (!pair.from_proj || !pair.to_proj) {
    throw new ThoughtRefError("NOT_FOUND", "one or both thoughts not found in this org");
  }

  const scope: "intra_project" | "cross_project" =
    pair.from_proj === pair.to_proj ? "intra_project" : "cross_project";
  const projectId = pair.from_proj;
  const now = Math.floor(Date.now() / 1000);

  const info = db
    .prepare(
      `INSERT OR IGNORE INTO thought_refs
       (from_thought_id, to_thought_id, relation, scope, origin, project_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      req.from_thought_id,
      req.to_thought_id,
      req.relation,
      scope,
      req.origin ?? "user_linked",
      projectId,
      now,
    );

  return {
    created: info.changes > 0,
    project_id: projectId,
    scope,
  };
}
