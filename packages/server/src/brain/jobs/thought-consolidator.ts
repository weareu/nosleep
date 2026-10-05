/**
 * Phase 22-F — sleep-time consolidator ("dream" pass).
 *
 * Soft-archives (visibility 'archived', see thoughts/visibility.ts) two kinds
 * of thought so retrieval stops surfacing them by default:
 *
 *   1. SUPERSEDED — target of a `supersedes` thought_ref whose source thought
 *      is still active. The newer thought explicitly replaces it.
 *   2. STALE — not recalled (get/search hit, see thoughts/recall.ts) for
 *      `stale_days` AND captured more than `stale_days` ago.
 *
 * Conservative by construction — a thought is NEVER archived when it is:
 *   - pinned (pinned_at set — unarchive pins by default),
 *   - linked to a live strategy node (pending/in_progress/blocked). Without a
 *     resolver every strategy-linked thought counts as live,
 *   - (stale rule only) the target of any ref from an active thought that was
 *     captured or recalled inside the window.
 *
 * Recall tracking only began when migration 013 was applied, so a NULL
 * last_recalled_at means "unknown", not "never read": the clock for such a
 * thought starts at max(created_at, tracking start). Existing corpora get a
 * full `stale_days` grace period instead of a mass archive on first run.
 *
 * Never deletes, never touches content/metadata/updated_at, bounded by
 * `max_per_run`, no LLM calls. Every run (dry or real) is recorded in
 * brain_session_events as `thought_consolidation_run` with the ids.
 * Reverse with unarchiveThoughts() / POST /api/brain/thoughts/unarchive.
 */

import { activeDbFor } from "../storage/active-db.js";
import { recordBrainAdminEvent, listBrainAdminEvents } from "../storage/admin-events.js";
import { VISIBILITY_ACTIVE, VISIBILITY_ARCHIVED } from "../thoughts/visibility.js";

export const CONSOLIDATION_RUN_EVENT = "thought_consolidation_run";
export const UNARCHIVE_EVENT = "thought_unarchive";
export const DEFAULT_STALE_DAYS = 90;
export const MIN_STALE_DAYS = 7;
export const DEFAULT_MAX_PER_RUN = 500;
const RECALL_TRACKING_MIGRATION_ID = 13;
const DAY_SEC = 86_400;

export interface ConsolidationOptions {
  org_id: string;
  dry_run?: boolean;
  stale_days?: number;
  max_per_run?: number;
  /** Unix seconds; defaults to now. */
  now_sec?: number;
  /** True when the strategy node a thought points at is still live. */
  isStrategyNodeLive?: (strategyNodeRef: string) => boolean;
  trigger?: "manual" | "scheduled";
}

export interface ConsolidationResult {
  org_id: string;
  dry_run: boolean;
  trigger: "manual" | "scheduled";
  stale_days: number;
  max_per_run: number;
  /** Ids archived (or, in a dry run, that would be). */
  archived_stale: string[];
  archived_superseded: string[];
  protected: { strategy: number; recent_inbound_ref: number; pinned: number };
  /** More eligible thoughts existed than max_per_run allowed. */
  capped: boolean;
  duration_ms: number;
}

export type ConsolidationRunRecord = ConsolidationResult & { ts: number };

interface CandidateRow {
  id: string;
  strategy_node_ref: string | null;
  pinned_at: number | null;
}

function recallTrackingStart(orgId: string, nowSec: number): number {
  const row = activeDbFor(orgId)
    .prepare(`SELECT applied_at FROM _brain_migrations WHERE id = ?`)
    .get(RECALL_TRACKING_MIGRATION_ID) as { applied_at: number } | undefined;
  return row?.applied_at ?? nowSec;
}

export function runThoughtConsolidation(opts: ConsolidationOptions): ConsolidationResult {
  const started = performance.now();
  const db = activeDbFor(opts.org_id);
  const nowSec = opts.now_sec ?? Math.floor(Date.now() / 1000);
  const staleDays = Math.max(MIN_STALE_DAYS, Math.floor(opts.stale_days ?? DEFAULT_STALE_DAYS));
  const maxPerRun = Math.max(1, Math.floor(opts.max_per_run ?? DEFAULT_MAX_PER_RUN));
  const dryRun = opts.dry_run ?? false;
  const cutoff = nowSec - staleDays * DAY_SEC;
  const baseline = recallTrackingStart(opts.org_id, nowSec);

  const protectedCounts = { strategy: 0, recent_inbound_ref: 0, pinned: 0 };
  const pinnedSeen = new Set<string>();
  const strategyCache = new Map<string, boolean>();
  const strategyLive = (ref: string): boolean => {
    if (!opts.isStrategyNodeLive) return true;
    let live = strategyCache.get(ref);
    if (live === undefined) {
      live = opts.isStrategyNodeLive(ref);
      strategyCache.set(ref, live);
    }
    return live;
  };
  /** Shared guards; counts each protected thought once per reason. */
  const isProtected = (row: CandidateRow, counted: Set<string>): boolean => {
    if (row.pinned_at !== null) {
      if (!pinnedSeen.has(row.id)) {
        pinnedSeen.add(row.id);
        protectedCounts.pinned += 1;
      }
      return true;
    }
    if (row.strategy_node_ref && strategyLive(row.strategy_node_ref)) {
      if (!counted.has(row.id)) {
        counted.add(row.id);
        protectedCounts.strategy += 1;
      }
      return true;
    }
    return false;
  };
  const strategyCounted = new Set<string>();

  const chosen = new Set<string>();
  const superseded: string[] = [];
  const stale: string[] = [];
  let capped = false;

  // 1. Superseded by an active thought.
  const supersededRows = db
    .prepare(
      `SELECT t.id, t.strategy_node_ref, t.pinned_at, r.from_thought_id AS from_id
         FROM thought_refs r
         JOIN thoughts t ON t.id = r.to_thought_id AND t.org_id = ? AND t.visibility = ?
         JOIN thoughts f ON f.id = r.from_thought_id AND f.visibility = ?
        WHERE r.relation = 'supersedes'
        ORDER BY r.created_at ASC`,
    )
    .all(opts.org_id, VISIBILITY_ACTIVE, VISIBILITY_ACTIVE) as Array<CandidateRow & { from_id: string }>;

  for (const row of supersededRows) {
    if (chosen.has(row.id)) continue;
    // A supersedes-cycle must not archive both sides in one pass.
    if (chosen.has(row.from_id)) continue;
    if (isProtected(row, strategyCounted)) continue;
    if (chosen.size >= maxPerRun) {
      capped = true;
      break;
    }
    chosen.add(row.id);
    superseded.push(row.id);
  }

  // 2. Stale: unrecalled and old, with no recent inbound reference.
  const staleRows = db
    .prepare(
      `SELECT t.id, t.strategy_node_ref, t.pinned_at,
              EXISTS (
                SELECT 1 FROM thought_refs r
                  JOIN thoughts f ON f.id = r.from_thought_id
                 WHERE r.to_thought_id = t.id
                   AND f.visibility = ?
                   AND MAX(f.created_at, COALESCE(f.last_recalled_at, 0)) >= ?
              ) AS has_recent_ref
         FROM thoughts t
        WHERE t.org_id = ?
          AND t.visibility = ?
          AND t.created_at < ?
          AND COALESCE(t.last_recalled_at, MAX(t.created_at, ?)) < ?
        ORDER BY COALESCE(t.last_recalled_at, MAX(t.created_at, ?)) ASC, t.created_at ASC`,
    )
    .all(
      VISIBILITY_ACTIVE,
      cutoff,
      opts.org_id,
      VISIBILITY_ACTIVE,
      cutoff,
      baseline,
      cutoff,
      baseline,
    ) as Array<CandidateRow & { has_recent_ref: number }>;

  for (const row of staleRows) {
    if (chosen.has(row.id)) continue;
    if (isProtected(row, strategyCounted)) continue;
    if (row.has_recent_ref) {
      protectedCounts.recent_inbound_ref += 1;
      continue;
    }
    if (chosen.size >= maxPerRun) {
      capped = true;
      break;
    }
    chosen.add(row.id);
    stale.push(row.id);
  }

  let archivedSuperseded = superseded;
  let archivedStale = stale;
  if (!dryRun && chosen.size > 0) {
    const archive = db.prepare(
      `UPDATE thoughts SET visibility = ? WHERE id = ? AND org_id = ? AND visibility = ?`,
    );
    const applied = new Set<string>();
    db.transaction(() => {
      for (const id of chosen) {
        if (archive.run(VISIBILITY_ARCHIVED, id, opts.org_id, VISIBILITY_ACTIVE).changes > 0) {
          applied.add(id);
        }
      }
    })();
    archivedSuperseded = superseded.filter((id) => applied.has(id));
    archivedStale = stale.filter((id) => applied.has(id));
  }

  const result: ConsolidationResult = {
    org_id: opts.org_id,
    dry_run: dryRun,
    trigger: opts.trigger ?? "manual",
    stale_days: staleDays,
    max_per_run: maxPerRun,
    archived_stale: archivedStale,
    archived_superseded: archivedSuperseded,
    protected: protectedCounts,
    capped,
    duration_ms: Math.round(performance.now() - started),
  };
  recordBrainAdminEvent(opts.org_id, CONSOLIDATION_RUN_EVENT, { ...result }, nowSec);
  return result;
}

export function listConsolidationRuns(orgId: string, limit: number = 20): ConsolidationRunRecord[] {
  return listBrainAdminEvents(orgId, CONSOLIDATION_RUN_EVENT, limit).map((e) => ({
    ...(e.payload as unknown as ConsolidationResult),
    ts: e.ts,
  }));
}

export interface UnarchiveOptions {
  org_id: string;
  ids: readonly string[];
  /** Pin so the next sweep can't re-archive it. Default true. */
  pin?: boolean;
  now_sec?: number;
}

export interface UnarchiveResult {
  restored: string[];
  /** Missing, or not in 'archived' state (active / merged) — left untouched. */
  not_archived: string[];
}

/**
 * Reverse the consolidator: archived → active. Also restarts the recall clock
 * (last_recalled_at = now) and, unless pin=false, pins the thought.
 * Merged-away thoughts are never touched.
 */
export function unarchiveThoughts(opts: UnarchiveOptions): UnarchiveResult {
  const db = activeDbFor(opts.org_id);
  const nowSec = opts.now_sec ?? Math.floor(Date.now() / 1000);
  const pin = opts.pin ?? true;
  const restore = db.prepare(
    `UPDATE thoughts
        SET visibility = ?, last_recalled_at = ?, pinned_at = CASE WHEN ? THEN ? ELSE pinned_at END
      WHERE id = ? AND org_id = ? AND visibility = ?`,
  );
  const restored: string[] = [];
  const notArchived: string[] = [];
  db.transaction(() => {
    for (const id of new Set(opts.ids)) {
      const changed = restore.run(
        VISIBILITY_ACTIVE,
        nowSec,
        pin ? 1 : 0,
        nowSec,
        id,
        opts.org_id,
        VISIBILITY_ARCHIVED,
      ).changes;
      (changed > 0 ? restored : notArchived).push(id);
    }
  })();
  if (restored.length > 0) {
    recordBrainAdminEvent(opts.org_id, UNARCHIVE_EVENT, { restored, pinned: pin }, nowSec);
  }
  return { restored, not_archived: notArchived };
}
