/**
 * Fetch a single thought by id, optionally with refs (thought_refs,
 * thought_archive_refs, entity_refs — entity refs populated from Phase 4).
 */

import { activeDbFor } from "../storage/active-db.js";
import { rowToThought } from "./capture.js";
import { markThoughtsRecalled } from "./recall.js";
import type { ThoughtRow } from "./types.js";

export interface ThoughtDetail extends ThoughtRow {
  archive_refs?: Array<{ archive_hash: string; relation: string }>;
  thought_refs?: {
    outgoing: Array<{ to_thought_id: string; relation: string }>;
    incoming: Array<{ from_thought_id: string; relation: string }>;
  };
  entity_refs?: Array<{ entity_id: string; relation: string }>;
}

export function getThought(
  orgId: string,
  id: string,
  includes: Set<string>,
): ThoughtDetail | null {
  const db = activeDbFor(orgId);
  const row = db
    .prepare(
      `SELECT id, org_id, project_id, content, metadata_json, thought_type,
              source_kind, source_refs_json, strategy_node_ref,
              created_at, updated_at, visibility
         FROM thoughts WHERE id = ? AND org_id = ?`,
    )
    .get(id, orgId) as Parameters<typeof rowToThought>[0] | undefined;

  if (!row) return null;
  markThoughtsRecalled(db, [id]);
  const out: ThoughtDetail = rowToThought(row);

  if (includes.has("archive_refs") || includes.has("refs")) {
    out.archive_refs = db
      .prepare(
        `SELECT archive_hash, relation FROM thought_archive_refs WHERE thought_id = ?`,
      )
      .all(id) as Array<{ archive_hash: string; relation: string }>;
  }

  if (includes.has("thought_refs") || includes.has("refs")) {
    const outgoing = db
      .prepare(
        `SELECT to_thought_id, relation FROM thought_refs WHERE from_thought_id = ?`,
      )
      .all(id) as Array<{ to_thought_id: string; relation: string }>;
    const incoming = db
      .prepare(
        `SELECT from_thought_id, relation FROM thought_refs WHERE to_thought_id = ?`,
      )
      .all(id) as Array<{ from_thought_id: string; relation: string }>;
    out.thought_refs = { outgoing, incoming };
  }

  if (includes.has("entity_refs") || includes.has("refs")) {
    out.entity_refs = db
      .prepare(
        `SELECT entity_id, relation FROM entity_refs
          WHERE referrer_kind = 'thought' AND referrer_id = ?`,
      )
      .all(id) as Array<{ entity_id: string; relation: string }>;
  }

  return out;
}
