/**
 * Daily brain maintenance — the scheduled half of Phase 22-E/F.
 *
 * Driven from the supervision loop's existing 30-minute housekeeping tick
 * (orchestrator/supervision-loop.ts pruneStaleEntries, the same tick that runs
 * brain telemetry retention). This function self-gates: each org runs at most
 * once per MIN_GAP, and the last run is read back from brain_session_events
 * after a restart so a crash/restart loop can't re-run it every boot.
 *
 * Per org, in order (each step isolated — a failure is logged and recorded,
 * never thrown):
 *   1. thought-dedup proposer   — writes thought_merge_proposals only; a
 *      human approves merges in the admin Merge Queue. No auto-merge.
 *   2. sleep-time consolidator  — soft-archives superseded + stale thoughts,
 *      capped per run, reversible.
 *
 * Neither step makes an LLM call (dedup reuses stored embeddings), so the
 * headless-claude / Haiku budget is untouched.
 *
 * Env (read at call time):
 *   NOSLEEP_BRAIN_MAINTENANCE=0           disable both steps
 *   NOSLEEP_BRAIN_DEDUP_NIGHTLY=0         disable dedup proposals
 *   NOSLEEP_BRAIN_CONSOLIDATE=on|dry-run|off   (default on; unknown → dry-run)
 *   NOSLEEP_BRAIN_CONSOLIDATE_DAYS=90     stale window (min 7)
 *   NOSLEEP_BRAIN_CONSOLIDATE_MAX=500     archive cap per org per run
 */

import type Database from "better-sqlite3";
import { runThoughtDedup, type ThoughtDedupResult } from "./thought-dedup.js";
import {
  runThoughtConsolidation,
  DEFAULT_MAX_PER_RUN,
  DEFAULT_STALE_DAYS,
  MIN_STALE_DAYS,
  type ConsolidationResult,
} from "./thought-consolidator.js";
import { recordBrainAdminEvent, listBrainAdminEvents } from "../storage/admin-events.js";

export const MAINTENANCE_RUN_EVENT = "brain_maintenance_run";
/** Slightly under a day so a 30-min tick doesn't drift the run later daily. */
const MIN_GAP_MS = 23 * 3600_000;
/** Strategy statuses that no longer pin their thoughts. */
const FINISHED_STRATEGY_STATUSES = new Set(["completed", "skipped"]);

export type ConsolidateMode = "on" | "dry-run" | "off";

export interface BrainMaintenanceConfig {
  enabled: boolean;
  dedup: boolean;
  consolidate: ConsolidateMode;
  stale_days: number;
  max_per_run: number;
}

export interface MaintenanceLog {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface OrgMaintenanceOutcome {
  status: "ran" | "not_due" | "disabled";
  dedup?: ThoughtDedupResult;
  dedup_error?: string;
  consolidation?: ConsolidationResult;
  consolidation_error?: string;
}

export interface RunBrainMaintenanceOptions {
  orgIds: readonly string[];
  /** Main NoSleep DB — used to check whether a thought's strategy node is live. */
  mainDb?: Database.Database;
  log: MaintenanceLog;
  nowMs?: number;
  config?: BrainMaintenanceConfig;
}

function intEnv(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function brainMaintenanceConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): BrainMaintenanceConfig {
  const rawMode = (env.NOSLEEP_BRAIN_CONSOLIDATE ?? "on").trim().toLowerCase();
  const consolidate: ConsolidateMode =
    rawMode === "on" || rawMode === "off" || rawMode === "dry-run" ? rawMode : "dry-run";
  return {
    enabled: env.NOSLEEP_BRAIN_MAINTENANCE !== "0",
    dedup: env.NOSLEEP_BRAIN_DEDUP_NIGHTLY !== "0",
    consolidate,
    stale_days: Math.max(MIN_STALE_DAYS, intEnv(env.NOSLEEP_BRAIN_CONSOLIDATE_DAYS, DEFAULT_STALE_DAYS)),
    max_per_run: intEnv(env.NOSLEEP_BRAIN_CONSOLIDATE_MAX, DEFAULT_MAX_PER_RUN),
  };
}

// Per-process memo of the last run per org (seeded from the DB once).
const lastRunMs = new Map<string, number>();
let inFlight = false;

/** Forget in-memory run times (tests: simulates a restart). */
export function resetBrainMaintenanceMemo(): void {
  lastRunMs.clear();
  inFlight = false;
}

function lastRunFor(orgId: string): number {
  const memo = lastRunMs.get(orgId);
  if (memo !== undefined) return memo;
  const [latest] = listBrainAdminEvents(orgId, MAINTENANCE_RUN_EVENT, 1);
  const ms = latest ? latest.ts * 1000 : 0;
  lastRunMs.set(orgId, ms);
  return ms;
}

function strategyResolver(mainDb: Database.Database | undefined): ((ref: string) => boolean) | undefined {
  if (!mainDb) return undefined; // consolidator then treats every ref as live
  let stmt: Database.Statement | null = null; // prepared lazily: only orgs with strategy-linked candidates touch the main DB
  return (ref) => {
    stmt ??= mainDb.prepare(`SELECT status FROM strategy_nodes WHERE id = ?`);
    const row = stmt.get(ref) as { status: string } | undefined;
    // A deleted node pins nothing; any status other than finished is live.
    if (!row) return false;
    return !FINISHED_STRATEGY_STATUSES.has(row.status);
  };
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function maintainOrg(
  orgId: string,
  opts: RunBrainMaintenanceOptions,
  cfg: BrainMaintenanceConfig,
  nowMs: number,
): Promise<OrgMaintenanceOutcome> {
  const out: OrgMaintenanceOutcome = { status: "ran" };

  if (cfg.dedup) {
    try {
      out.dedup = await runThoughtDedup({ org_id: orgId });
    } catch (e) {
      out.dedup_error = errMsg(e);
      opts.log.error({ component: "brain-maintenance", org: orgId, step: "dedup", err: out.dedup_error }, "brain maintenance step failed");
    }
  }

  if (cfg.consolidate !== "off") {
    try {
      // Resolver is built lazily inside the try so a broken main DB only
      // fails this step for this org.
      out.consolidation = runThoughtConsolidation({
        org_id: orgId,
        dry_run: cfg.consolidate === "dry-run",
        stale_days: cfg.stale_days,
        max_per_run: cfg.max_per_run,
        now_sec: Math.floor(nowMs / 1000),
        isStrategyNodeLive: strategyResolver(opts.mainDb),
        trigger: "scheduled",
      });
    } catch (e) {
      out.consolidation_error = errMsg(e);
      opts.log.error({ component: "brain-maintenance", org: orgId, step: "consolidate", err: out.consolidation_error }, "brain maintenance step failed");
    }
  }

  recordBrainAdminEvent(
    orgId,
    MAINTENANCE_RUN_EVENT,
    {
      config: cfg,
      dedup: out.dedup ?? null,
      dedup_error: out.dedup_error ?? null,
      consolidation: out.consolidation
        ? {
            dry_run: out.consolidation.dry_run,
            archived_stale: out.consolidation.archived_stale.length,
            archived_superseded: out.consolidation.archived_superseded.length,
            capped: out.consolidation.capped,
          }
        : null,
      consolidation_error: out.consolidation_error ?? null,
    },
    Math.floor(nowMs / 1000),
  );
  opts.log.info(
    {
      component: "brain-maintenance",
      org: orgId,
      dedup_proposed: out.dedup?.proposed ?? null,
      archived_stale: out.consolidation?.archived_stale.length ?? null,
      archived_superseded: out.consolidation?.archived_superseded.length ?? null,
      dry_run: out.consolidation?.dry_run ?? null,
    },
    "brain maintenance ran",
  );
  return out;
}

/**
 * Run dedup + consolidation for every org whose last run is older than the
 * daily gap. Safe to call on every housekeeping tick. Never throws.
 */
export async function runBrainMaintenanceIfDue(
  opts: RunBrainMaintenanceOptions,
): Promise<Record<string, OrgMaintenanceOutcome>> {
  const cfg = opts.config ?? brainMaintenanceConfigFromEnv();
  const nowMs = opts.nowMs ?? Date.now();
  const results: Record<string, OrgMaintenanceOutcome> = {};
  if (inFlight) return results;
  inFlight = true;
  try {
    for (const orgId of opts.orgIds) {
      if (!cfg.enabled) {
        results[orgId] = { status: "disabled" };
        continue;
      }
      try {
        if (nowMs - lastRunFor(orgId) < MIN_GAP_MS) {
          results[orgId] = { status: "not_due" };
          continue;
        }
        lastRunMs.set(orgId, nowMs);
        results[orgId] = await maintainOrg(orgId, opts, cfg, nowMs);
      } catch (e) {
        opts.log.error({ component: "brain-maintenance", org: orgId, err: errMsg(e) }, "brain maintenance failed");
      }
      // Yield between orgs.
      await new Promise((res) => setImmediate(res));
    }
  } finally {
    inFlight = false;
  }
  return results;
}
