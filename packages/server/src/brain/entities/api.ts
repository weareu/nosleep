/**
 * Entity read/write helpers for the REST API + MCP tools.
 */

import { activeDbFor } from "../storage/active-db.js";
import type { EntityKindT, EntityRow, EntityRefRow } from "./types.js";

export interface ListEntitiesOptions {
  orgId: string;
  kind?: EntityKindT;
  projectId?: string;
  order?: "frequency" | "recent" | "alpha";
  limit?: number;
  includeHidden?: boolean;
}

function rowToEntity(row: {
  id: string;
  org_id: string;
  kind: string;
  canonical_name: string;
  aliases_json: string | null;
  metadata_json: string | null;
  merged_into: string | null;
  created_at: number;
  visibility: string;
}): EntityRow {
  const aliases = row.aliases_json
    ? (safeJson<string[]>(row.aliases_json) ?? [])
    : [];
  const metadata = row.metadata_json ? safeJson<unknown>(row.metadata_json) : null;
  return {
    id: row.id,
    org_id: row.org_id,
    kind: row.kind as EntityKindT,
    canonical_name: row.canonical_name,
    aliases,
    metadata_json: metadata,
    merged_into: row.merged_into,
    created_at: row.created_at,
    visibility: row.visibility,
  };
}

function safeJson<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

export function listEntities(
  opts: ListEntitiesOptions,
): Array<EntityRow & { ref_count: number }> {
  const db = activeDbFor(opts.orgId);
  const conds = ["e.org_id = ?"];
  const params: (string | number)[] = [opts.orgId];
  if (!opts.includeHidden) conds.push("e.visibility = 'active'");
  if (opts.kind) {
    conds.push("e.kind = ?");
    params.push(opts.kind);
  }
  // Resolved canonical only (exclude rows that are merge-redirects)
  conds.push("e.merged_into IS NULL");

  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));

  let orderClause = "ref_count DESC";
  if (opts.order === "recent") orderClause = "e.created_at DESC";
  else if (opts.order === "alpha") orderClause = "e.canonical_name ASC";

  const projectScoped = opts.projectId
    ? "WHERE referrer_kind = 'thought' AND project_id = ?"
    : "WHERE referrer_kind = 'thought'";
  if (opts.projectId) params.unshift(opts.projectId);

  const sql = `
    SELECT e.id, e.org_id, e.kind, e.canonical_name, e.aliases_json,
           e.metadata_json, e.merged_into, e.created_at, e.visibility,
           (SELECT COUNT(*) FROM entity_refs
             ${projectScoped}
             AND entity_id = e.id) AS ref_count
      FROM entities e
     WHERE ${conds.join(" AND ")}
     ORDER BY ${orderClause}
     LIMIT ?
  `;
  const rows = db.prepare(sql).all(...params, limit) as Array<
    Parameters<typeof rowToEntity>[0] & { ref_count: number }
  >;
  return rows.map((r) => ({ ...rowToEntity(r), ref_count: r.ref_count }));
}

export interface EntityDetail extends EntityRow {
  ref_count: number;
  recent_refs: EntityRefRow[];
  related: Array<{ id: string; canonical_name: string; kind: EntityKindT; co_count: number }>;
  merge_target?: EntityRow | null;
}

export function getEntity(
  orgId: string,
  id: string,
  includeHidden: boolean = false,
): EntityDetail | null {
  const db = activeDbFor(orgId);
  const row = db
    .prepare(
      `SELECT id, org_id, kind, canonical_name, aliases_json, metadata_json,
              merged_into, created_at, visibility
         FROM entities WHERE id = ? AND org_id = ?`,
    )
    .get(id, orgId) as Parameters<typeof rowToEntity>[0] | undefined;
  if (!row) return null;
  if (!includeHidden && row.visibility !== "active") return null;

  const base = rowToEntity(row);

  const refs = db
    .prepare(
      `SELECT entity_id, referrer_kind, referrer_id, project_id, relation, created_at
         FROM entity_refs WHERE entity_id = ? ORDER BY created_at DESC LIMIT 50`,
    )
    .all(id) as EntityRefRow[];

  const refCountRow = db
    .prepare(`SELECT COUNT(*) AS c FROM entity_refs WHERE entity_id = ?`)
    .get(id) as { c: number };

  const related = db
    .prepare(
      `SELECT e2.id, e2.canonical_name, e2.kind, COUNT(*) AS co_count
         FROM entity_refs r1
         JOIN entity_refs r2 ON r1.referrer_id = r2.referrer_id
                            AND r1.referrer_kind = r2.referrer_kind
         JOIN entities e2 ON e2.id = r2.entity_id
        WHERE r1.entity_id = ? AND r2.entity_id != r1.entity_id
          AND e2.visibility = 'active'
          AND e2.merged_into IS NULL
        GROUP BY e2.id
        ORDER BY co_count DESC
        LIMIT 10`,
    )
    .all(id) as Array<{
    id: string;
    canonical_name: string;
    kind: string;
    co_count: number;
  }>;

  let mergeTarget: EntityRow | null = null;
  if (base.merged_into) {
    const trow = db
      .prepare(
        `SELECT id, org_id, kind, canonical_name, aliases_json, metadata_json,
                merged_into, created_at, visibility
           FROM entities WHERE id = ? AND org_id = ?`,
      )
      .get(base.merged_into, orgId) as Parameters<typeof rowToEntity>[0] | undefined;
    if (trow) mergeTarget = rowToEntity(trow);
  }

  return {
    ...base,
    ref_count: refCountRow.c,
    recent_refs: refs,
    related: related.map((r) => ({
      id: r.id,
      canonical_name: r.canonical_name,
      kind: r.kind as EntityKindT,
      co_count: r.co_count,
    })),
    merge_target: mergeTarget,
  };
}

export function addAlias(orgId: string, id: string, alias: string): boolean {
  const db = activeDbFor(orgId);
  const row = db
    .prepare(`SELECT aliases_json FROM entities WHERE id = ? AND org_id = ?`)
    .get(id, orgId) as { aliases_json: string | null } | undefined;
  if (!row) return false;
  const aliases: string[] = row.aliases_json
    ? (safeJson<string[]>(row.aliases_json) ?? [])
    : [];
  const cleaned = alias.trim();
  if (!cleaned) return false;
  if (aliases.some((a) => a.toLowerCase() === cleaned.toLowerCase())) return false;
  aliases.push(cleaned);
  db.prepare(`UPDATE entities SET aliases_json = ? WHERE id = ?`).run(
    JSON.stringify(aliases),
    id,
  );
  return true;
}

export class EntityMergeError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "EntityMergeError";
  }
}

/**
 * Lazy merge: set `merged_into = target_id`. Queries resolve through the
 * redirect so no row rewrites required. Blocks obvious cycles.
 */
export function mergeInto(
  orgId: string,
  sourceId: string,
  targetId: string,
): void {
  if (sourceId === targetId) {
    throw new EntityMergeError("SELF_MERGE", "cannot merge entity into itself");
  }
  const db = activeDbFor(orgId);

  const source = db
    .prepare(`SELECT kind FROM entities WHERE id = ? AND org_id = ?`)
    .get(sourceId, orgId) as { kind: string } | undefined;
  const target = db
    .prepare(`SELECT kind, merged_into FROM entities WHERE id = ? AND org_id = ?`)
    .get(targetId, orgId) as { kind: string; merged_into: string | null } | undefined;
  if (!source || !target) {
    throw new EntityMergeError("NOT_FOUND", "source or target entity not found");
  }
  if (source.kind !== target.kind) {
    throw new EntityMergeError(
      "KIND_MISMATCH",
      `source kind ${source.kind} !== target kind ${target.kind}`,
    );
  }
  if (target.merged_into === sourceId) {
    throw new EntityMergeError("CYCLE", "would create a merge cycle");
  }

  db.prepare(`UPDATE entities SET merged_into = ? WHERE id = ? AND org_id = ?`).run(
    targetId,
    sourceId,
    orgId,
  );
}
