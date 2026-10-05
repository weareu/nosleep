/**
 * Phase 10 — scheduled URL re-fetch worker.
 *
 * Iterates reference/link artifacts whose latest linked document/web_fetch
 * is older than `url.refetch.interval_days` (per-org config) and refetches
 * them via captureUrlFull. If the new fetch produces a different hash than
 * the prior, a `supersedes` edge is added so callers can find the latest
 * version while history remains intact.
 */

import type Database from "better-sqlite3";
import { activeDbFor } from "../storage/active-db.js";
import { captureUrlFull } from "../extractors/url-fetcher-full.js";
import { getConfig } from "../config-store.js";

const DEFAULT_INTERVAL_DAYS = 7;
const DEFAULT_MAX_AGE_DAYS = 365;
const DEFAULT_BATCH_LIMIT = 50;

export interface RefetchOptions {
  org_id: string;
  project_id?: string;
  interval_days?: number;
  limit?: number;
  max_age_days?: number;
}

export interface RefetchResult {
  candidates: number;
  attempted: number;
  refetched_unchanged: number;
  refetched_changed: number;
  failed: number;
  duration_ms: number;
}

interface LinkRow {
  hash: string;
  ts: number;
  org_id: string;
  project_id: string;
  kind_specific_meta: string | null;
  last_fetch_ts: number | null;
  last_fetch_hash: string | null;
}

export async function runUrlRefetch(
  opts: RefetchOptions,
): Promise<RefetchResult> {
  const started = performance.now();
  const db = activeDbFor(opts.org_id);

  const intervalDays =
    opts.interval_days ??
    (Number(getConfig(opts.org_id, "url.refetch.interval_days")) ||
      DEFAULT_INTERVAL_DAYS);
  const maxAgeDays =
    opts.max_age_days ??
    (Number(getConfig(opts.org_id, "url.refetch.max_age_days")) ||
      DEFAULT_MAX_AGE_DAYS);
  const limit = opts.limit ?? DEFAULT_BATCH_LIMIT;

  const nowSec = Math.floor(Date.now() / 1000);
  const intervalCutoff = nowSec - intervalDays * 86_400;
  const maxAgeCutoff = nowSec - maxAgeDays * 86_400;

  const params: (string | number)[] = [
    opts.org_id,
    maxAgeCutoff,
    intervalCutoff,
    intervalCutoff,
  ];
  let projectClause = "";
  if (opts.project_id) {
    projectClause = "AND a.project_id = ?";
    params.push(opts.project_id);
  }
  params.push(limit);

  const links = db
    .prepare(
      `SELECT a.hash AS hash, a.ts AS ts, a.org_id AS org_id,
              a.project_id AS project_id,
              a.kind_specific_meta AS kind_specific_meta,
              (
                SELECT MAX(d.ts) FROM artifact_edges e
                JOIN artifacts d ON d.hash = e.from_hash
                WHERE e.to_hash = a.hash
                  AND e.relation = 'link_resolved_to_fetch'
                  AND d.kind = 'document/web_fetch'
              ) AS last_fetch_ts,
              (
                SELECT d.hash FROM artifact_edges e
                JOIN artifacts d ON d.hash = e.from_hash
                WHERE e.to_hash = a.hash
                  AND e.relation = 'link_resolved_to_fetch'
                  AND d.kind = 'document/web_fetch'
                ORDER BY d.ts DESC LIMIT 1
              ) AS last_fetch_hash
         FROM artifacts a
        WHERE a.kind = 'reference/link'
          AND a.org_id = ?
          AND a.ts >= ?
          AND (
            (SELECT MAX(d.ts) FROM artifact_edges e
              JOIN artifacts d ON d.hash = e.from_hash
              WHERE e.to_hash = a.hash
                AND e.relation = 'link_resolved_to_fetch'
                AND d.kind = 'document/web_fetch') < ?
            OR (SELECT MAX(d.ts) FROM artifact_edges e
                 JOIN artifacts d ON d.hash = e.from_hash
                 WHERE e.to_hash = a.hash
                   AND e.relation = 'link_resolved_to_fetch'
                   AND d.kind = 'document/web_fetch') IS NULL
          )
          ${projectClause}
        ORDER BY a.ts ASC
        LIMIT ?`,
    )
    .all(...params) as LinkRow[];

  let attempted = 0;
  let unchanged = 0;
  let changed = 0;
  let failed = 0;

  void intervalCutoff;

  for (const link of links) {
    attempted += 1;
    let url: string | null = null;
    try {
      const meta = link.kind_specific_meta
        ? (JSON.parse(link.kind_specific_meta) as Record<string, unknown>)
        : {};
      url =
        typeof meta.normalized_url === "string"
          ? (meta.normalized_url as string)
          : typeof meta.url === "string"
            ? (meta.url as string)
            : null;
    } catch {
      url = null;
    }
    if (!url) {
      failed += 1;
      continue;
    }

    try {
      const result = await captureUrlFull({
        url,
        org_id: link.org_id,
        project_id: link.project_id,
        link_hash: link.hash,
        tags: ["refetch"],
      });
      if (result.error || !result.fetch_hash) {
        failed += 1;
        continue;
      }
      if (result.fetch_hash === link.last_fetch_hash) {
        unchanged += 1;
        continue;
      }
      if (link.last_fetch_hash) {
        addSupersedesEdge(db, result.fetch_hash, link.last_fetch_hash);
      }
      changed += 1;
    } catch {
      failed += 1;
    }
  }

  return {
    candidates: links.length,
    attempted,
    refetched_unchanged: unchanged,
    refetched_changed: changed,
    failed,
    duration_ms: performance.now() - started,
  };
}

function addSupersedesEdge(
  db: Database.Database,
  fromHash: string,
  toHash: string,
): void {
  try {
    const projectId =
      (
        db
          .prepare(`SELECT project_id FROM artifacts WHERE hash = ?`)
          .get(fromHash) as { project_id: string } | undefined
      )?.project_id ?? "_org_level";
    db.prepare(
      `INSERT OR IGNORE INTO artifact_edges
       (from_hash, to_hash, relation, scope, origin, project_id, created_at)
       VALUES (?, ?, 'supersedes', 'intra_artifact', 'url_refetch', ?, ?)`,
    ).run(fromHash, toHash, projectId, Math.floor(Date.now() / 1000));
  } catch {
    /* edge insert is best-effort */
  }
}
