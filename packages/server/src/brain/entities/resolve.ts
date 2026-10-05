/**
 * Entity resolution. Given a raw name + kind, either find an existing entity
 * via canonical name or alias match (scoped to org) or create a new one.
 * Returns the entity_id. Resolves through `merged_into` lazily so queries
 * always land on the active canonical.
 */

import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { activeDbFor } from "../storage/active-db.js";
import {
  canonicaliseName,
  ENTITY_STOPWORDS,
  type EntityKindT,
} from "./types.js";

export interface ResolveResult {
  entity_id: string;
  created: boolean;
  merged_redirect?: string; // set if we followed a merged_into chain
}

export function resolveEntity(
  orgId: string,
  kind: EntityKindT,
  rawName: string,
): ResolveResult | null {
  const canon = canonicaliseName(rawName);
  if (!canon || canon.length < 2) return null;
  if (ENTITY_STOPWORDS.has(canon)) return null;

  const db = activeDbFor(orgId);

  // 1) Direct canonical match
  const direct = db
    .prepare(
      `SELECT id, merged_into FROM entities
        WHERE org_id = ? AND kind = ? AND canonical_name = ? LIMIT 1`,
    )
    .get(orgId, kind, canon) as
    | { id: string; merged_into: string | null }
    | undefined;

  if (direct) {
    return resolveMerged(db, direct.id);
  }

  // 2) Alias match — aliases stored as JSON array, scan within same kind
  const byAlias = db
    .prepare(
      `SELECT id, merged_into, aliases_json FROM entities
        WHERE org_id = ? AND kind = ? AND aliases_json IS NOT NULL`,
    )
    .all(orgId, kind) as Array<{
    id: string;
    merged_into: string | null;
    aliases_json: string;
  }>;

  for (const e of byAlias) {
    try {
      const aliases: string[] = JSON.parse(e.aliases_json);
      if (aliases.some((a) => canonicaliseName(a) === canon)) {
        return resolveMerged(db, e.id);
      }
    } catch {
      // bad json — ignore this entity
    }
  }

  // 3) Create a new entity
  const id = `ent_${nanoid(16)}`;
  const now = Math.floor(Date.now() / 1000);
  try {
    db.prepare(
      `INSERT INTO entities
       (id, org_id, kind, canonical_name, aliases_json, metadata_json, merged_into, created_at, visibility)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, 'active')`,
    ).run(id, orgId, kind, canon, now);
    return { entity_id: id, created: true };
  } catch {
    // Race: another writer created the same canonical_name concurrently.
    // Re-query to pick up the winning row.
    const retry = db
      .prepare(
        `SELECT id FROM entities
          WHERE org_id = ? AND kind = ? AND canonical_name = ? LIMIT 1`,
      )
      .get(orgId, kind, canon) as { id: string } | undefined;
    if (retry) return resolveMerged(db, retry.id);
    return null;
  }
}

function resolveMerged(
  db: Database.Database,
  startId: string,
  maxHops: number = 5,
): ResolveResult {
  let current = startId;
  let redirect: string | undefined;
  for (let hops = 0; hops < maxHops; hops++) {
    const row = db
      .prepare(`SELECT merged_into FROM entities WHERE id = ?`)
      .get(current) as { merged_into: string | null } | undefined;
    if (!row || !row.merged_into) break;
    redirect = row.merged_into;
    current = row.merged_into;
  }
  return { entity_id: current, created: false, merged_redirect: redirect };
}

/** Insert an entity_refs row idempotently. */
export function recordEntityRef(
  orgId: string,
  entityId: string,
  referrerKind: "thought" | "artifact",
  referrerId: string,
  projectId: string,
  relation: string = "mentions",
): void {
  const db = activeDbFor(orgId);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT OR IGNORE INTO entity_refs
     (entity_id, referrer_kind, referrer_id, project_id, relation, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(entityId, referrerKind, referrerId, projectId, relation, now);
}
