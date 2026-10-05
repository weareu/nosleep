/**
 * Shared SQLite query helpers used by mcp-control and mcp-gateway.
 *
 * Both MCP servers run org-scoped read/write queries against the same NoSleep
 * SQLite database. Before this module they each had their own copy of the
 * same SQL — strategy node lookups, session resolution, alert listing, memory
 * lookups. This file is the single source of truth.
 *
 * Every helper takes `db` as its first argument so the same query can be
 * called from any consumer that has a Database handle.
 */

import type Database from "better-sqlite3";
import type { StrategyRow } from "./strategy-helpers.js";
import { effectiveProgressPct, rolledUpStatus, weightedProgressPct } from "./strategy-helpers.js";

// ── Strategy node queries ────────────────────────────────

/** Fetch a strategy node by id, or undefined if missing. */
export function getStrategyNode(db: Database.Database, id: string): StrategyRow | undefined {
  return db.prepare(`SELECT * FROM strategy_nodes WHERE id = ?`).get(id) as StrategyRow | undefined;
}

/** Fetch a strategy node by id within a specific org. */
export function getStrategyNodeInOrg(db: Database.Database, id: string, orgId: string): StrategyRow | undefined {
  return db.prepare(`SELECT * FROM strategy_nodes WHERE id = ? AND org_id = ?`).get(id, orgId) as StrategyRow | undefined;
}

/** Fetch all strategy nodes for a project, ordered by priority/sort_order. */
export function listProjectStrategy(db: Database.Database, projectId: string, orgId: string): StrategyRow[] {
  return db.prepare(`
    SELECT * FROM strategy_nodes
    WHERE project_id = ? AND org_id = ?
    ORDER BY COALESCE(priority, 3), sort_order
  `).all(projectId, orgId) as StrategyRow[];
}

/** Fetch all strategy nodes for a project including depth-ordered results. */
export function listProjectStrategyByDepth(db: Database.Database, projectId: string, orgId: string): StrategyRow[] {
  return db.prepare(`
    SELECT * FROM strategy_nodes
    WHERE project_id = ? AND org_id = ?
    ORDER BY COALESCE(priority, 3), depth, sort_order
  `).all(projectId, orgId) as StrategyRow[];
}

/** Fetch direct children of a strategy node. */
export function getStrategyChildren(db: Database.Database, parentId: string): StrategyRow[] {
  return db.prepare(`
    SELECT * FROM strategy_nodes
    WHERE parent_id = ?
    ORDER BY COALESCE(priority, 3), sort_order
  `).all(parentId) as StrategyRow[];
}

/** Walk parent chain from a node up to the root, returning titles in root→leaf order. */
export function getStrategyPath(db: Database.Database, nodeId: string): string[] {
  const path: string[] = [];
  let cur = getStrategyNode(db, nodeId);
  while (cur) {
    path.unshift(cur.title);
    cur = cur.parent_id ? getStrategyNode(db, cur.parent_id) : undefined;
  }
  return path;
}

/** Get the next sort_order for a new child of the given parent. */
export function getNextSortOrder(db: Database.Database, parentId: string): number {
  const row = db.prepare(`
    SELECT COALESCE(MAX(sort_order), -1) + 1 as n FROM strategy_nodes WHERE parent_id = ?
  `).get(parentId) as { n: number };
  return row.n;
}

/**
 * Recompute `parentId`'s stored progress + status from its children and
 * recurse to the root. Single implementation for the server tree manager,
 * mcp-control and mcp-gateway.
 */
export function propagateStrategyProgress(db: Database.Database, parentId: string | null): void {
  let current = parentId;
  while (current) {
    const children = db
      .prepare(`SELECT status, progress_pct, weight FROM strategy_nodes WHERE parent_id = ?`)
      .all(current) as Array<{ status: string; progress_pct: number; weight: number }>;
    if (children.length === 0) return;
    const avg = weightedProgressPct(
      children.map((c) => ({ pct: effectiveProgressPct(c.status, c.progress_pct), weight: c.weight })),
    );
    db.prepare(
      `UPDATE strategy_nodes SET progress_pct = ?, status = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(avg, rolledUpStatus(children, avg), current);
    const parent = db.prepare(`SELECT parent_id FROM strategy_nodes WHERE id = ?`).get(current) as
      | { parent_id: string | null }
      | undefined;
    current = parent?.parent_id ?? null;
  }
}

// ── Session queries ──────────────────────────────────────

/** Resolve the org_id for a session (now denormalized — single-table lookup). */
export function getSessionOrg(db: Database.Database, sessionId: string): string | undefined {
  const row = db.prepare(`SELECT org_id FROM sessions WHERE id = ?`).get(sessionId) as { org_id: string | null } | undefined;
  return row?.org_id ?? undefined;
}

/** Resolve the project_id for a session. */
export function getSessionProject(db: Database.Database, sessionId: string): string | undefined {
  const row = db.prepare(`SELECT project_id FROM sessions WHERE id = ?`).get(sessionId) as { project_id: string } | undefined;
  return row?.project_id;
}

/** Verify a session belongs to a given org (for org-scoped MCP authorization). */
export function sessionInOrg(db: Database.Database, sessionId: string, orgId: string): boolean {
  const row = db.prepare(`SELECT 1 as ok FROM sessions WHERE id = ? AND org_id = ?`).get(sessionId, orgId) as { ok: number } | undefined;
  return !!row;
}

// ── Project live status ──────────────────────────────────

/** Session statuses that count as live/running everywhere (org badge, project status). */
export const LIVE_SESSION_STATUSES_SQL = "('starting', 'running', 'idle', 'waiting_input')";

/**
 * Project status is DERIVED from its sessions, never trusted from the stored
 * `projects.status` column: sessions arrive from many paths (orchestrator
 * launches, hook/API `/api/sessions/register`, the scheduler) and only the
 * orchestrator used to write the column, so hook-registered sessions left
 * projects "idle" forever. One SQL expression, used by every reader (REST
 * for web + mobile, mcp-control, mcp-gateway):
 *
 *   any LIVE session (starting/running/idle/waiting_input — the same set
 *   the org "N running" badge counts) → 'running'
 *   else any session paused      → 'paused'
 *   else stored 'error'          → 'error'   (sticky operator-visible state)
 *   else                         → 'idle'
 *
 * `alias` is the projects table alias in the caller's query (a constant,
 * never caller input).
 */
export function projectLiveStatusSql(alias = "p"): string {
  return `(CASE
    WHEN EXISTS (SELECT 1 FROM sessions ls WHERE ls.project_id = ${alias}.id AND ls.status IN ${LIVE_SESSION_STATUSES_SQL}) THEN 'running'
    WHEN EXISTS (SELECT 1 FROM sessions ls WHERE ls.project_id = ${alias}.id AND ls.status = 'paused') THEN 'paused'
    WHEN ${alias}.status = 'error' THEN 'error'
    ELSE 'idle' END)`;
}

// ── Alert queries ────────────────────────────────────────

export interface AlertRow {
  readonly id: number;
  readonly org_id: string;
  readonly session_id: string | null;
  readonly project_id: string | null;
  readonly type: string;
  readonly severity: string;
  readonly message: string;
  readonly acknowledged: number;
  readonly created_at: string;
}

/** List recent drift alerts for a session. */
export function listSessionDriftAlerts(db: Database.Database, sessionId: string, orgId: string, limit = 3): Array<{ message: string }> {
  return db.prepare(`
    SELECT message FROM alerts
    WHERE session_id = ? AND org_id = ? AND type = 'drift' AND acknowledged = 0
    ORDER BY created_at DESC LIMIT ?
  `).all(sessionId, orgId, limit) as Array<{ message: string }>;
}

/** List org alerts with optional acked filter. */
export function listOrgAlerts(db: Database.Database, orgId: string, opts: { includeAcked?: boolean; limit?: number } = {}): AlertRow[] {
  const limit = opts.limit ?? 20;
  if (opts.includeAcked) {
    return db.prepare(`SELECT * FROM alerts WHERE org_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(orgId, limit) as AlertRow[];
  }
  return db.prepare(`SELECT * FROM alerts WHERE org_id = ? AND acknowledged = 0 ORDER BY created_at DESC LIMIT ?`)
    .all(orgId, limit) as AlertRow[];
}

/** Acknowledge a single alert (returns true if a row was updated). */
export function acknowledgeAlert(db: Database.Database, alertId: number, orgId: string): boolean {
  const result = db.prepare(`UPDATE alerts SET acknowledged = 1 WHERE id = ? AND org_id = ?`).run(alertId, orgId);
  return result.changes > 0;
}

/** Acknowledge all unacked alerts for an org (returns count updated). */
export function acknowledgeAllOrgAlerts(db: Database.Database, orgId: string): number {
  const result = db.prepare(`UPDATE alerts SET acknowledged = 1 WHERE org_id = ? AND acknowledged = 0`).run(orgId);
  return result.changes;
}

// ── Token budget queries ─────────────────────────────────

/** Get a session's token usage and the project's budget. */
export function getSessionBudget(db: Database.Database, sessionId: string, orgId: string): { tokens_used: number; token_budget: number } | undefined {
  return db.prepare(`
    SELECT s.tokens_used, p.token_budget
    FROM sessions s JOIN projects p ON s.project_id = p.id
    WHERE s.id = ? AND s.org_id = ?
  `).get(sessionId, orgId) as { tokens_used: number; token_budget: number } | undefined;
}

// ── Autonomous-loop config (project_loops) ─────────────────────────────────

export type LoopMode = "continue" | "content" | "branch";

export interface LoopConfig {
  project_id: string;
  enabled: number; // 0/1
  mode: LoopMode;
  content: string | null;
  linked_node_id: string | null;
  interval_minutes: number;
  last_target_id: string | null;
  no_progress_count: number;
  updated_at: string;
}

const LOOP_DEFAULTS = {
  enabled: 0,
  mode: "continue" as LoopMode,
  content: null,
  linked_node_id: null,
  interval_minutes: 10,
  last_target_id: null,
  no_progress_count: 0,
};

/** Read a project's loop config, returning defaults (not persisted) when none exists. */
export function getLoopConfig(db: Database.Database, projectId: string): LoopConfig {
  const row = db
    .prepare(`SELECT * FROM project_loops WHERE project_id = ?`)
    .get(projectId) as LoopConfig | undefined;
  if (row) return row;
  return { project_id: projectId, ...LOOP_DEFAULTS, updated_at: "" };
}

export interface LoopConfigPatch {
  enabled?: boolean;
  mode?: LoopMode;
  content?: string | null;
  linkedNodeId?: string | null;
  intervalMinutes?: number;
  lastTargetId?: string | null;
  noProgressCount?: number;
}

/** Upsert a project's loop config. Only provided fields change; the rest keep
 *  their current (or default) value. */
export function upsertLoopConfig(db: Database.Database, projectId: string, patch: LoopConfigPatch): LoopConfig {
  const cur = getLoopConfig(db, projectId);
  const next: LoopConfig = {
    project_id: projectId,
    enabled: patch.enabled === undefined ? cur.enabled : patch.enabled ? 1 : 0,
    mode: patch.mode ?? cur.mode,
    content: patch.content === undefined ? cur.content : patch.content,
    linked_node_id: patch.linkedNodeId === undefined ? cur.linked_node_id : patch.linkedNodeId,
    interval_minutes:
      patch.intervalMinutes === undefined
        ? cur.interval_minutes
        : Math.max(1, Math.min(Math.floor(patch.intervalMinutes), 7 * 24 * 60)),
    last_target_id: patch.lastTargetId === undefined ? cur.last_target_id : patch.lastTargetId,
    no_progress_count: patch.noProgressCount === undefined ? cur.no_progress_count : patch.noProgressCount,
    updated_at: "",
  };
  db.prepare(`
    INSERT INTO project_loops (project_id, enabled, mode, content, linked_node_id, interval_minutes, last_target_id, no_progress_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(project_id) DO UPDATE SET
      enabled = excluded.enabled,
      mode = excluded.mode,
      content = excluded.content,
      linked_node_id = excluded.linked_node_id,
      interval_minutes = excluded.interval_minutes,
      last_target_id = excluded.last_target_id,
      no_progress_count = excluded.no_progress_count,
      updated_at = datetime('now')
  `).run(
    projectId,
    next.enabled,
    next.mode,
    next.content,
    next.linked_node_id,
    next.interval_minutes,
    next.last_target_id,
    next.no_progress_count,
  );
  return getLoopConfig(db, projectId);
}
