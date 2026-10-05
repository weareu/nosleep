/**
 * Brain config read/write helpers. catalog.db.brain_config is a key/value
 * store for per-org and per-project tunables (embed allowlist overrides,
 * intent weights, rerank thresholds, etc.).
 *
 * Key convention: `<scope>.<area>.<name>` — e.g.
 *   `project.<project_id>.embed_allowlist`
 *   `org.embed_allowlist`
 *   `org.intent_weights`
 */

import { catalogDbFor } from "./storage/catalog-db.js";

export function getConfig<T = unknown>(
  orgId: string,
  key: string,
): T | null {
  const db = catalogDbFor(orgId);
  const row = db
    .prepare(`SELECT value_json FROM brain_config WHERE key = ?`)
    .get(key) as { value_json: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return null;
  }
}

export function setConfig(orgId: string, key: string, value: unknown): void {
  const db = catalogDbFor(orgId);
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO brain_config (key, value_json, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), now);
}

/** Resolve the effective embed allowlist for a project. */
export function getEmbedAllowlist(
  orgId: string,
  projectId: string,
): string[] | null {
  const projectOverride = getConfig<string[]>(
    orgId,
    `project.${projectId}.embed_allowlist`,
  );
  if (projectOverride) return projectOverride;
  const orgDefault = getConfig<string[]>(orgId, "org.embed_allowlist");
  return orgDefault ?? null;
}
