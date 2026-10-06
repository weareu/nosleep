/**
 * Organizations — user-defined, stored in the `organizations` table, which is
 * the single source of truth. Nothing in code may name a specific org other
 * than the seeded default (`org_personal`). Server routes and the MCP gateway
 * both go through these helpers so create/rename/delete behave identically
 * from every entrypoint.
 */

import type Database from "better-sqlite3";

export interface OrgRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly color: string;
  readonly created_at: string;
}

/** Deterministic fallback palette for orgs without a (valid) colour. */
export const ORG_COLOR_PALETTE = [
  "#6366f1", // indigo
  "#f59e0b", // amber
  "#10b981", // emerald
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#8b5cf6", // violet
  "#ef4444", // red
  "#84cc16", // lime
] as const;

export const ORG_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const ORG_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const ORG_NAME_MAX = 60;

/** Org id derived from a slug — `org_<slug>`. */
export function orgIdForSlug(slug: string): string {
  return `org_${slug}`;
}

/** Env var holding a per-org API key: NOSLEEP_API_KEY_<SLUG_UPPER> (`-` → `_`). */
export function orgApiKeyEnvName(slug: string): string {
  return `NOSLEEP_API_KEY_${slug.toUpperCase().replace(/-/g, "_")}`;
}

/** Stable palette pick from the org id (FNV-1a), so a colour never flickers. */
export function paletteColorFor(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ORG_COLOR_PALETTE[h % ORG_COLOR_PALETTE.length];
}

/** The org's stored colour, or the deterministic palette colour if unset/invalid. */
export function resolveOrgColor(id: string, color: string | null | undefined): string {
  return color && ORG_COLOR_RE.test(color) ? color : paletteColorFor(id);
}

export class OrgError extends Error {
  constructor(
    readonly code: "invalid" | "conflict" | "not_found" | "not_empty" | "protected",
    message: string,
  ) {
    super(message);
    this.name = "OrgError";
  }
}

/** The seeded default org — every install has it; it cannot be deleted. */
export const DEFAULT_ORG_ID = "org_personal";

function normalize(row: OrgRow): OrgRow {
  return { ...row, color: resolveOrgColor(row.id, row.color) };
}

/** All orgs: the default org first, then in creation order. */
export function listOrgs(db: Database.Database): OrgRow[] {
  const rows = db
    .prepare(
      `SELECT id, name, slug, color, created_at FROM organizations
       ORDER BY (id = ?) DESC, created_at, rowid`,
    )
    .all(DEFAULT_ORG_ID) as OrgRow[];
  return rows.map(normalize);
}

export function getOrg(db: Database.Database, idOrSlug: string): OrgRow | undefined {
  const row = db
    .prepare(`SELECT id, name, slug, color, created_at FROM organizations WHERE id = ? OR slug = ?`)
    .get(idOrSlug, idOrSlug) as OrgRow | undefined;
  return row ? normalize(row) : undefined;
}

function validName(name: unknown): string {
  const n = typeof name === "string" ? name.trim() : "";
  if (!n || n.length > ORG_NAME_MAX) {
    throw new OrgError("invalid", `name must be 1-${ORG_NAME_MAX} characters`);
  }
  return n;
}

function validColor(color: unknown): string | null {
  if (color === undefined || color === null || color === "") return null;
  if (typeof color !== "string" || !ORG_COLOR_RE.test(color)) {
    throw new OrgError("invalid", "color must be a hex colour like #3b82f6");
  }
  return color.toLowerCase();
}

/** Lower-case, hyphenated slug suggestion from a display name. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

export interface CreateOrgInput {
  readonly name: string;
  readonly slug?: string;
  readonly color?: string | null;
}

export function createOrg(db: Database.Database, input: CreateOrgInput): OrgRow {
  const name = validName(input.name);
  const slug = (input.slug ?? slugify(name)).trim();
  if (!ORG_SLUG_RE.test(slug)) {
    throw new OrgError("invalid", "slug must be 1-40 chars of a-z, 0-9 and '-', not starting/ending with '-'");
  }
  const id = orgIdForSlug(slug);
  const exists = db.prepare(`SELECT 1 FROM organizations WHERE id = ? OR slug = ?`).get(id, slug);
  if (exists) throw new OrgError("conflict", `an org with slug "${slug}" already exists`);
  const color = validColor(input.color) ?? paletteColorFor(id);
  db.prepare(`INSERT INTO organizations (id, name, slug, color) VALUES (?, ?, ?, ?)`).run(id, name, slug, color);
  return getOrg(db, id)!;
}

export interface UpdateOrgInput {
  readonly name?: string;
  readonly color?: string | null;
}

/** Rename / recolour. The slug and id are immutable (they key storage + API keys). */
export function updateOrg(db: Database.Database, id: string, input: UpdateOrgInput): OrgRow {
  const current = db.prepare(`SELECT id FROM organizations WHERE id = ?`).get(id);
  if (!current) throw new OrgError("not_found", `org ${id} not found`);
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.name !== undefined) {
    sets.push("name = ?");
    params.push(validName(input.name));
  }
  if (input.color !== undefined) {
    sets.push("color = ?");
    params.push(validColor(input.color) ?? paletteColorFor(id));
  }
  if (sets.length === 0) throw new OrgError("invalid", "nothing to update (name, color)");
  db.prepare(`UPDATE organizations SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
  return getOrg(db, id)!;
}

/**
 * Row counts per table that hold data for this org. Discovered from the
 * schema (every table with an `org_id` column), so a new org-scoped table is
 * covered without touching this function.
 */
export function orgDataCounts(db: Database.Database, id: string): Record<string, number> {
  const tables = db
    .prepare(
      `SELECT m.name FROM sqlite_master m
       WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
         AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) c WHERE c.name = 'org_id')`,
    )
    .all() as Array<{ name: string }>;
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const quoted = `"${name.replace(/"/g, '""')}"`;
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${quoted} WHERE org_id = ?`).get(id) as { n: number };
    if (row.n > 0) counts[name] = row.n;
  }
  return counts;
}

/** Delete an org. Refuses the default org and any org that still owns data. */
export function deleteOrg(db: Database.Database, id: string): void {
  if (id === DEFAULT_ORG_ID) throw new OrgError("protected", "the default org cannot be deleted");
  const current = db.prepare(`SELECT id FROM organizations WHERE id = ?`).get(id);
  if (!current) throw new OrgError("not_found", `org ${id} not found`);
  const counts = orgDataCounts(db, id);
  const parts = Object.entries(counts).map(([t, n]) => `${t}: ${n}`);
  if (parts.length > 0) {
    throw new OrgError("not_empty", `org still has data (${parts.join(", ")}) — move or delete it first`);
  }
  db.prepare(`DELETE FROM organizations WHERE id = ?`).run(id);
}
