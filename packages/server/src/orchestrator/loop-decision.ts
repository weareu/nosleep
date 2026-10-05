/**
 * The autonomous-loop brain. Given a project's loop config (project_loops),
 * decides what the next Stop-hook iteration should do:
 *   - continue: keep driving the strategy tree (legacy behaviour)
 *   - content : inject the AI-supplied content verbatim
 *   - branch  : drive a specific node's subtree; auto-stop when it completes
 *
 * Two things this fixes vs the old inline decide-next logic:
 *  1. The AI can DISABLE / CHANGE the loop (via the project_loops config the
 *     gateway loop_* actions write) — the loop is no longer un-stoppable.
 *  2. A no-progress guard stops the loop when it would otherwise re-inject the
 *     same in_progress task forever ("drives forever wasting tokens when
 *     there's nothing to do"). Every decision also carries delayMinutes so the
 *     hook WAITS (cron piggyback) instead of hammering immediately.
 */

import type Database from "better-sqlite3";
import { getLoopConfig, upsertLoopConfig } from "@nosleep/shared";
import { StrategyTreeManager } from "../strategy/tree-manager.js";

// Stop the loop after this many consecutive iterations that re-inject the same
// target without it completing.
export const NO_PROGRESS_LIMIT = 3;

export interface LoopDecision {
  action: "stop" | "continue" | "next_task";
  reason?: string;
  response?: string;
  content?: string;
  nextTask?: {
    id: string;
    title: string;
    description: string;
    acceptanceCriteria: string[];
    type: string;
  } | null;
  delayMinutes: number;
}

/** Ids of a node and all its descendants (the branch). */
function subtreeIds(db: Database.Database, rootId: string): string[] {
  const rows = db
    .prepare(
      `WITH RECURSIVE sub(id) AS (
         SELECT ?
         UNION ALL
         SELECT sn.id FROM strategy_nodes sn JOIN sub ON sn.parent_id = sub.id
       ) SELECT id FROM sub`,
    )
    .all(rootId) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export function resolveLoopDecision(
  db: Database.Database,
  projectId: string,
  opts: { stopReason?: string } = {},
): LoopDecision {
  const cfg = getLoopConfig(db, projectId);
  const delayMinutes = cfg.interval_minutes;

  if (!cfg.enabled) {
    return { action: "stop", reason: "Loop is disabled.", delayMinutes };
  }

  if (opts.stopReason === "user_cancelled" || opts.stopReason === "interrupted") {
    return { action: "stop", reason: "Human interrupted. Not auto-continuing.", delayMinutes };
  }

  // CONTENT mode — inject the AI-set content each iteration; stop if empty.
  if (cfg.mode === "content") {
    const c = (cfg.content ?? "").trim();
    if (!c) {
      upsertLoopConfig(db, projectId, { enabled: false });
      return { action: "stop", reason: "Loop mode is 'content' but no content is set — disabling loop.", delayMinutes };
    }
    return { action: "continue", content: c, delayMinutes };
  }

  // BRANCH / CONTINUE — drive the strategy tree. Use getNextActionable, which
  // respects DEPENDENCIES (FS/SS), skipped/completed ancestors, and leaf-only
  // selection — branch mode restricts it to the linked node's subtree.
  const tree = new StrategyTreeManager(db);
  let scope: Set<string> | undefined;
  let candidateIds: string[];
  if (cfg.mode === "branch") {
    if (!cfg.linked_node_id) {
      upsertLoopConfig(db, projectId, { enabled: false });
      return { action: "stop", reason: "Loop mode is 'branch' but no node is linked — disabling loop.", delayMinutes };
    }
    candidateIds = subtreeIds(db, cfg.linked_node_id);
    scope = new Set(candidateIds);
  } else {
    candidateIds = (db.prepare(`SELECT id FROM strategy_nodes WHERE project_id = ?`).all(projectId) as Array<{ id: string }>).map((r) => r.id);
  }

  const next = tree.getNextActionable(projectId, scope);
  if (next) {
    db.prepare(
      `UPDATE strategy_nodes SET status = 'in_progress', started_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'pending'`,
    ).run(next.id);
    const reset = next.id !== cfg.last_target_id;
    upsertLoopConfig(db, projectId, { lastTargetId: next.id, noProgressCount: reset ? 0 : cfg.no_progress_count });
    return {
      action: "next_task",
      nextTask: { id: next.id, title: next.title, description: next.description, acceptanceCriteria: [...next.acceptanceCriteria], type: next.type },
      delayMinutes,
    };
  }

  // No ACTIONABLE pending task. Is anything still in_progress, or are pending
  // tasks merely blocked on dependencies?
  let inProgress: { id: string; title: string } | undefined;
  let blockedOrPending = 0;
  if (candidateIds.length > 0) {
    const ph = candidateIds.map(() => "?").join(",");
    inProgress = db
      .prepare(
        `SELECT id, title FROM strategy_nodes WHERE project_id = ? AND status = 'in_progress' AND id IN (${ph}) ORDER BY COALESCE(priority, 3) LIMIT 1`,
      )
      .get(projectId, ...candidateIds) as { id: string; title: string } | undefined;
    blockedOrPending = (db
      .prepare(`SELECT COUNT(*) AS n FROM strategy_nodes WHERE project_id = ? AND status IN ('pending','blocked') AND id IN (${ph})`)
      .get(projectId, ...candidateIds) as { n: number }).n;
  }

  if (!inProgress) {
    if (cfg.mode === "branch") upsertLoopConfig(db, projectId, { enabled: false });
    // Distinguish "everything done" from "stuck on unmet deps / blocked".
    const reason = blockedOrPending > 0
      ? (cfg.mode === "branch"
          ? "Linked branch has no actionable task — remaining work is blocked on dependencies. Loop auto-stopped."
          : "No actionable task — remaining tasks are blocked on dependencies. Stopping.")
      : (cfg.mode === "branch"
          ? "Linked branch is complete — loop auto-stopped."
          : "All strategy-tree tasks are completed or skipped. Nothing left to do.");
    return { action: "stop", delayMinutes, reason };
  }

  // Only in_progress remains — no-progress guard against forever-driving.
  const sameTarget = inProgress.id === cfg.last_target_id;
  const count = sameTarget ? cfg.no_progress_count + 1 : 1;
  if (count >= NO_PROGRESS_LIMIT) {
    upsertLoopConfig(db, projectId, { enabled: false, lastTargetId: inProgress.id, noProgressCount: 0 });
    return {
      action: "stop",
      delayMinutes,
      reason: `Task "${inProgress.title}" has stayed in_progress across ${NO_PROGRESS_LIMIT} loop iterations with no completion — stopping to avoid wasting tokens. Mark it complete/skipped, link a different branch, or change the loop content (nosleep loop_set).`,
    };
  }
  upsertLoopConfig(db, projectId, { lastTargetId: inProgress.id, noProgressCount: count });
  return {
    action: "continue",
    response: `Continue working on: "${inProgress.title}" (in_progress). If it's actually done, mark it complete; if there's genuinely nothing to do, stop the loop with nosleep loop_stop.`,
    delayMinutes,
  };
}
