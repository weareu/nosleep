import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionManager } from "../orchestrator/session-manager.js";
import { resolveLoopDecision } from "../orchestrator/loop-decision.js";
import { diskHasHeadroom, MIN_FREE_GB } from "../brain/ingest/disk-guard.js";
import { getLogger } from "../logger.js";

const log = getLogger("task-scheduler");

const TICK_INTERVAL_MS = 60_000; // 1 minute

interface ScheduledTaskRow {
  id: string;
  project_id: string;
  org_id: string;
  name: string;
  cron_hour: number;
  cron_minute: number;
  days_of_week: string;
  goal_template: string;
  task_type: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  // Loop redesign (migration 23) — interval / one-shot / strat-tree mode.
  mode: string; // 'cron' | 'interval'
  interval_minutes: number | null;
  oneshot: number; // 0 | 1
  strategy_mode: string; // 'template' | 'next_actionable'
}

/** Next run for an interval task = now + N minutes. */
function calculateNextIntervalRun(intervalMinutes: number): string {
  const n = Math.max(1, Math.floor(intervalMinutes));
  return new Date(Date.now() + n * 60_000).toISOString();
}

/** Compute next_run_at for any task regardless of mode. */
function nextRunForTask(task: ScheduledTaskRow): string {
  if (task.mode === "interval" && task.interval_minutes) {
    return calculateNextIntervalRun(task.interval_minutes);
  }
  return calculateNextRun(task.cron_hour, task.cron_minute, task.days_of_week);
}

interface ProjectRow {
  id: string;
  org_id: string;
  path: string;
  account_id: string;
  autonomy_level: string;
}

const DEFAULT_TASKS: ReadonlyArray<{
  name: string;
  cronHour: number;
  cronMinute: number;
  daysOfWeek: string;
  goalTemplate: string;
  taskType: string;
}> = [
  {
    name: "Log Analysis & Bug Fix",
    cronHour: 0,
    cronMinute: 0,
    daysOfWeek: "1,2,3,4,5",
    goalTemplate:
      "Review all error logs, client logs, and behavioral logs for this project. For each issue found: 1) Fix the bug if straightforward, 2) If complex, add a suggestion to the strategy tree via plan_ingest or strategy_add. Focus on: runtime errors, unhandled exceptions, performance regressions, user-facing bugs. Do NOT create test-only changes — fix real issues.",
    taskType: "review",
  },
  {
    name: "Architecture Review",
    cronHour: 14,
    cronMinute: 0,
    daysOfWeek: "1,2,3,4,5",
    goalTemplate:
      "Perform a full architecture review of this project. Check: code organization, dependency structure, coupling between modules, performance bottlenecks, scalability concerns, technical debt. For each issue found, create a strategy tree node via strategy_add with type 'task' and clear acceptance criteria. Be specific — name files, functions, and the exact problem.",
    taskType: "review",
  },
  {
    name: "Issues Review",
    cronHour: 18,
    cronMinute: 0,
    daysOfWeek: "1,2,3,4,5",
    goalTemplate:
      "Review all open issues, TODOs, FIXMEs, and HACKs in the codebase. Check git log for recent failed CI, revert commits, or hotfixes. For each issue: assess severity, add to strategy tree if not already tracked, and fix any quick wins (< 5 minutes each). Summarize findings via goal_progress.",
    taskType: "review",
  },
  {
    name: "Security Review",
    cronHour: 21,
    cronMinute: 0,
    daysOfWeek: "1,2,3,4,5",
    goalTemplate:
      'Perform a full security audit of this project. Check for: hardcoded secrets, SQL injection, XSS, CSRF, command injection, path traversal, insecure dependencies (npm audit), exposed debug endpoints, missing auth checks, overly permissive CORS. Fix critical issues immediately. Add non-critical findings to the strategy tree.',
    taskType: "review",
  },
];

/**
 * Calculate the next run datetime >= now that matches the given cron spec.
 */
function calculateNextRun(
  cronHour: number,
  cronMinute: number,
  daysOfWeek: string,
): string {
  const allowedDays = new Set(
    daysOfWeek.split(",").map((d) => parseInt(d.trim(), 10)),
  );
  const now = new Date();
  // Start from the current date/time
  const candidate = new Date(now);
  candidate.setSeconds(0, 0);

  // Try today first: if the time hasn't passed and the day matches
  if (
    allowedDays.has(candidate.getDay()) &&
    (candidate.getHours() < cronHour ||
      (candidate.getHours() === cronHour &&
        candidate.getMinutes() < cronMinute))
  ) {
    candidate.setHours(cronHour, cronMinute, 0, 0);
    return candidate.toISOString();
  }

  // Move to tomorrow and scan up to 7 days ahead
  candidate.setDate(candidate.getDate() + 1);
  candidate.setHours(cronHour, cronMinute, 0, 0);

  for (let i = 0; i < 7; i++) {
    if (allowedDays.has(candidate.getDay())) {
      return candidate.toISOString();
    }
    candidate.setDate(candidate.getDate() + 1);
  }

  // Fallback: shouldn't reach here if daysOfWeek is valid
  return candidate.toISOString();
}

// Hard cap to prevent the scheduler from getting wedged behind a hung session.
// If a scheduled task hasn't completed in this long, we assume something is
// wrong and release the queue lock.
const TASK_MAX_RUNTIME_MS = 4 * 60 * 60 * 1000; // 4 hours

export class TaskScheduler {
  private readonly db: Database.Database;
  private readonly sessionManager: SessionManager;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private taskQueue: ScheduledTaskRow[] = [];
  private currentTaskRunning = false;
  private lastRotSweep = 0;
  private readonly watchHandles = new Set<ReturnType<typeof setInterval>>();
  private readonly watchTimeouts = new Set<ReturnType<typeof setTimeout>>();

  constructor(db: Database.Database, sessionManager: SessionManager) {
    this.db = db;
    this.sessionManager = sessionManager;
  }

  start(): void {
    if (this.intervalHandle) return;
    // Clamp any past-due next_run_at to the next future occurrence on boot.
    // Prevents the post-restart pileup where dozens of tasks all fire at once.
    this.clampPastDueOnStartup();
    this.intervalHandle = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    log.info("started — checking every 60s (queued, 1-at-a-time, dead time only)");
  }

  /**
   * Find managed (non-manual) sessions in 'running' status whose recorded PID
   * no longer exists, mark them as failed, and emit an alert. This catches the
   * gap where a Claude process was OOM-killed or SIGKILL'd before it could
   * trigger the normal exit handler.
   *
   * Manual sessions have null PID — they're skipped here and handled by the
   * separate 2-hour-idle cleanup query.
   */
  private reapDeadManagedSessions(): void {
    const stale = this.db.prepare(`
      SELECT id, project_id, org_id, pid FROM sessions
      WHERE status IN ('running', 'idle') AND pid IS NOT NULL
    `).all() as Array<{ id: string; project_id: string; org_id: string; pid: number }>;

    if (stale.length === 0) return;

    const markFailed = this.db.prepare(`
      UPDATE sessions SET status = 'failed', ended_at = datetime('now') WHERE id = ?
    `);
    const insertAlert = this.db.prepare(`
      INSERT INTO alerts (org_id, project_id, session_id, type, severity, message)
      VALUES (?, ?, ?, 'stale_session_reaped', 'warning', ?)
    `);

    let reaped = 0;
    for (const s of stale) {
      if (this.isProcessAlive(s.pid)) continue;
      markFailed.run(s.id);
      insertAlert.run(
        s.org_id,
        s.project_id,
        s.id,
        `Session ${s.id.slice(0, 12)} reaped — PID ${s.pid} no longer alive`,
      );
      reaped++;
    }
    if (reaped > 0) {
      log.warn({ count: reaped }, "reaped stale managed sessions with dead PIDs");
    }
  }

  /**
   * Check if a process is still alive. Sending signal 0 doesn't deliver a
   * signal — it just probes whether the OS knows about the PID.
   *   - ESRCH: process doesn't exist → false
   *   - EPERM: process exists but we lack permission → true (still alive)
   *   - any other error: assume alive (don't reap on uncertain signal)
   */
  private isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false;
      if (code === "EPERM") return true;
      // Unknown error — be conservative and don't reap
      return true;
    }
  }

  private clampPastDueOnStartup(): void {
    const now = new Date().toISOString();
    // Only clamp recurring (cron / non-oneshot interval) tasks. A one-shot
    // delayed wake that came due while the server was down should still fire
    // on the next tick — clamping it to "the future" would silently drop the
    // loop continuation, so we leave oneshot rows alone.
    const stale = this.db
      .prepare(`SELECT * FROM scheduled_tasks WHERE enabled = 1 AND oneshot = 0 AND next_run_at IS NOT NULL AND next_run_at <= ?`)
      .all(now) as ScheduledTaskRow[];

    if (stale.length === 0) return;

    const update = this.db.prepare(`UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?`);
    for (const t of stale) {
      update.run(nextRunForTask(t), t.id);
    }
    log.info({ count: stale.length }, "clamped past-due tasks to next future occurrence");
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    for (const h of this.watchHandles) clearInterval(h);
    for (const t of this.watchTimeouts) clearTimeout(t);
    this.watchHandles.clear();
    this.watchTimeouts.clear();
    this.currentTaskRunning = false;
    log.info("stopped");
  }

  private tick(): void {
    // Auto-heal: reap managed sessions whose Claude process has died.
    // We can detect this by sending signal 0 to the PID — throws ESRCH if the
    // process no longer exists. This catches OOM kills, SIGKILL, and any other
    // termination path that bypassed the exit handler.
    this.reapDeadManagedSessions();

    // Auto-heal: mark stale manual sessions as stopped (no activity for 2 hours)
    this.db.prepare(`
      UPDATE sessions SET status = 'stopped', ended_at = datetime('now')
      WHERE status IN ('running', 'idle') AND id LIKE 'manual_%'
      AND last_activity_at < datetime('now', '-2 hours')
    `).run();

    // Auto-heal: spawned (non-manual) sessions stuck idle for 4+ hours
    this.db.prepare(`
      UPDATE sessions SET status = 'failed', ended_at = datetime('now')
      WHERE status = 'running' AND id NOT LIKE 'manual_%'
      AND last_activity_at < datetime('now', '-4 hours')
    `).run();

    // Auto-heal: sessions stuck in 'starting' for >10min — process likely died before
    // it ever recorded activity. Mark failed so retries / strategy advance can proceed.
    this.db.prepare(`
      UPDATE sessions SET status = 'failed', ended_at = datetime('now')
      WHERE status = 'starting' AND started_at < datetime('now', '-10 minutes')
    `).run();

    // Auto-heal: stop sessions for inactive projects
    this.db.prepare(`
      UPDATE sessions SET status = 'stopped', ended_at = datetime('now')
      WHERE status = 'running'
      AND project_id IN (SELECT id FROM projects WHERE active = 0)
    `).run();

    // Auto-heal: stop duplicate manual sessions for the SAME Claude Code
    // session (keep newest). Partition by the CC session identity, NOT by
    // project — two distinct Claude sessions running in the same folder are
    // legitimately concurrent and must both stay visible. (Was PARTITION BY
    // project_id, which force-stopped all-but-one session per folder within a
    // tick → "I don't see all sessions".) COALESCE so rows without a
    // claude_session_id are each their own partition (keyed by unique id) and
    // are never deduped against each other.
    this.db.prepare(`
      UPDATE sessions SET status = 'stopped', ended_at = datetime('now')
      WHERE status = 'running' AND id LIKE 'manual_%' AND id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY COALESCE(claude_session_id, id) ORDER BY last_activity_at DESC) as rn
          FROM sessions WHERE status = 'running' AND id LIKE 'manual_%'
        ) WHERE rn = 1
      )
    `).run();

    // Disk-headroom watch: below the floor the brain pauses ingestion (see
    // brain/ingest/disk-guard) — surface that loudly, once (dedup on unacked).
    try {
      const headroom = diskHasHeadroom(process.cwd());
      if (!headroom.ok) {
        const existing = this.db.prepare(
          `SELECT 1 FROM alerts WHERE type = 'disk_low' AND acknowledged = 0 LIMIT 1`,
        ).get();
        if (!existing) {
          this.db.prepare(
            `INSERT INTO alerts (org_id, project_id, type, severity, message) VALUES ('org_personal', NULL, 'disk_low', 'critical', ?)`,
          ).run(`Disk critically low: ${headroom.freeGB.toFixed(1)}GB free (< ${MIN_FREE_GB}GB floor). Brain ingest is PAUSED until space is freed — biggest consumer is data/brain (org_apply active.db).`);
        }
      }
    } catch { /* guard is best-effort */ }

    // Strategy-rot sweeper (daily): in_progress nodes that nothing touched in
    // 7+ days with NO running session assigned are dead work-claims — a
    // session marked them in_progress and died. They silently BLOCK their
    // branches (not pending → never picked again; 596 across 17 projects at
    // 2026-07-15 sweep design, some rotting since March). Demote to pending
    // (honest + recoverable) and raise one summary alert per sweep.
    if (Date.now() - this.lastRotSweep > 24 * 3600_000) {
      this.lastRotSweep = Date.now();
      try {
        const rotted = this.db.prepare(`
          UPDATE strategy_nodes SET status = 'pending', updated_at = datetime('now')
          WHERE status = 'in_progress'
          AND updated_at < datetime('now', '-7 days')
          AND id NOT IN (
            SELECT strategy_node_id FROM sessions
            WHERE status = 'running' AND strategy_node_id IS NOT NULL
          )
          AND id NOT IN (SELECT parent_id FROM strategy_nodes WHERE parent_id IS NOT NULL)
        `).run();
        if (rotted.changes > 0) {
          log.warn({ demoted: rotted.changes }, "rot sweep: demoted stale in_progress leaves to pending");
          this.db.prepare(
            `INSERT INTO alerts (org_id, project_id, type, severity, message) VALUES ('org_personal', NULL, 'strategy_rot_swept', 'warning', ?)`,
          ).run(`Rot sweep: ${rotted.changes} in_progress task(s) untouched for 7+ days with no live session were demoted to pending (they were silently blocking their branches). Review priorities or skip obsolete ones.`);
        }
      } catch { /* sweep is best-effort */ }
    }

    // Auto-heal: acknowledge aged informational alerts. info-severity items
    // (session_complete, routine notices) piled up ~900 unacked and drowned
    // the real warnings on the dashboard. Warnings/criticals stay until a
    // human acks them.
    this.db.prepare(`
      UPDATE alerts SET acknowledged = 1
      WHERE acknowledged = 0 AND severity = 'info'
      AND created_at < datetime('now', '-3 days')
    `).run();

    // 'idle' warnings are transient by nature (the session either resumed or
    // ended long ago) and 'session_error' loses actionability once the
    // session is weeks gone. 300+ of each sat unacked back to April, burying
    // the one real critical (disk_low). Other warnings/criticals still wait
    // for a human.
    this.db.prepare(`
      UPDATE alerts SET acknowledged = 1
      WHERE acknowledged = 0 AND type = 'idle'
      AND created_at < datetime('now', '-3 days')
    `).run();
    this.db.prepare(`
      UPDATE alerts SET acknowledged = 1
      WHERE acknowledged = 0 AND type = 'session_error'
      AND created_at < datetime('now', '-14 days')
    `).run();

    // Dead-time gate: only count SPAWNED (autonomous) sessions globally.
    // Manual/interactive sessions can stay 'running' for DAYS (hooks keep
    // last_activity fresh), and gating on them starved every cron — one
    // nightly review sat unrun from April to July. A human typing in one
    // repo must not block reviews for every other project. Same-repo
    // collision is prevented per-task in runTask (project-busy check).
    const activeSessions = this.db.prepare(`
      SELECT COUNT(*) as n FROM sessions WHERE status = 'running' AND id NOT LIKE 'manual_%'
    `).get() as { n: number };

    if (activeSessions.n > 0) {
      return; // An autonomous session is working — don't compete for resources
    }

    // If a task is already running from the queue, wait for it to finish
    if (this.currentTaskRunning) return;

    // Collect due tasks into the queue (if queue is empty)
    if (this.taskQueue.length === 0) {
      const now = new Date().toISOString();
      const dueTasks = this.db
        .prepare(
          `SELECT st.* FROM scheduled_tasks st JOIN projects p ON st.project_id = p.id WHERE st.enabled = 1 AND p.active = 1 AND st.next_run_at IS NOT NULL AND st.next_run_at <= ?`,
        )
        .all(now) as ScheduledTaskRow[];

      // Add to queue — they'll run one at a time
      this.taskQueue.push(...dueTasks);
      if (dueTasks.length > 0) {
        log.info({ count: dueTasks.length }, "queued tasks for dead-time execution");
      }
    }

    // Run the next task from the queue
    const task = this.taskQueue.shift();
    if (!task) return;

    let launched = false;
    let failReason = "";
    try {
      this.currentTaskRunning = true;
      const result = this.runTask(task);
      launched = result.launched;
      failReason = result.reason ?? "";

      if (launched) {
        // Watch for the session to complete, then allow next task
        this.watchForCompletion(task);
      } else {
        // Nothing was spawned — release the gate immediately so the queue moves.
        this.currentTaskRunning = false;
      }
    } catch (err) {
      log.error({ taskId: task.id, taskName: task.name, err }, "error running scheduled task");
      this.currentTaskRunning = false;
      failReason = err instanceof Error ? err.message : String(err);
      // Dedup: a budget-blocked wake retries every interval all night — one
      // unacked alert per task is signal, sixty are noise.
      const dup = this.db.prepare(
        `SELECT 1 FROM alerts WHERE type = 'scheduled_task_error' AND acknowledged = 0 AND project_id IS ? AND message LIKE ? LIMIT 1`,
      ).get(task.project_id, `Scheduled task "${task.name}"%`);
      if (!dup) {
        this.db.prepare(
          `INSERT INTO alerts (org_id, project_id, type, severity, message) VALUES (?, ?, ?, ?, ?)`,
        ).run(task.org_id, task.project_id, "scheduled_task_error", "warning",
          `Scheduled task "${task.name}" failed: ${failReason}`);
      }
    }

    this.stampAfterRun(task, launched, failReason);
  }

  /**
   * Post-run bookkeeping. One-shots normally run exactly once — BUT a loop
   * wake that failed for a TRANSIENT reason (budget pacer, project busy)
   * must RESCHEDULE itself, not self-consume: the next wake is normally
   * scheduled by the launched session's stop hook, so consuming the oneshot
   * on a transient failure killed the whole loop chain (the "loop enabled
   * but nothing ever runs" incident). Terminal reasons (loop disabled /
   * complete / nothing to do / broken config) still consume the wake.
   */
  private stampAfterRun(task: ScheduledTaskRow, launched: boolean, failReason: string): void {
    if (task.oneshot === 1) {
      const transient = !launched && /budget|pacer|busy|already running/i.test(failReason);
      if (transient) {
        const retryMinutes = Math.max(5, task.interval_minutes ?? 10);
        const nextRun = new Date(Date.now() + retryMinutes * 60_000).toISOString();
        log.info({ taskName: task.name, failReason, retryMinutes }, "oneshot wake deferred (transient) — rescheduling");
        this.db.prepare(
          `UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?`,
        ).run(nextRun, task.id);
        return;
      }
      this.db.prepare(
        `UPDATE scheduled_tasks SET last_run_at = CASE WHEN ? = 1 THEN datetime('now') ELSE last_run_at END, enabled = 0, next_run_at = NULL WHERE id = ?`,
      ).run(launched ? 1 : 0, task.id);
    } else {
      const nextRun = nextRunForTask(task);
      this.db.prepare(
        `UPDATE scheduled_tasks SET last_run_at = CASE WHEN ? = 1 THEN datetime('now') ELSE last_run_at END, next_run_at = ? WHERE id = ?`,
      ).run(launched ? 1 : 0, nextRun, task.id);
    }
  }

  /** Surface a scheduled-launch skip as an alert. A silent skip that still
   *  stamps last_run_at as "success" hides a permanently-misconfigured task
   *  forever (observability contract). Benign skips (no actionable task) do
   *  NOT call this. */
  private alertSkip(task: ScheduledTaskRow, reason: string): void {
    try {
      this.db.prepare(
        `INSERT INTO alerts (org_id, project_id, type, severity, message) VALUES (?, ?, ?, ?, ?)`,
      ).run(task.org_id, task.project_id, "scheduled_task_skipped", "warning",
        `Scheduled task "${task.name}" did not launch: ${reason}`);
    } catch { /* alert is best-effort */ }
  }

  private runTask(task: ScheduledTaskRow): { launched: boolean; reason?: string } {
    const project = this.db
      .prepare(
        `SELECT id, org_id, path, account_id, autonomy_level FROM projects WHERE id = ?`,
      )
      .get(task.project_id) as ProjectRow | undefined;

    if (!project) {
      log.warn({ projectId: task.project_id }, "project not found, skipping task");
      this.alertSkip(task, "project not found");
      return { launched: false, reason: "project not found" };
    }

    // Project-busy check: if ANY session (incl. a human's interactive one) is
    // running for THIS project, don't launch autonomous work into the same
    // repo. Benign skip — next_run_at advances, no alert. This is the per-repo
    // half of the dead-time gate (the global half only counts spawned sessions).
    const busy = this.db.prepare(
      `SELECT COUNT(*) as n FROM sessions WHERE status = 'running' AND project_id = ?`,
    ).get(task.project_id) as { n: number };
    if (busy.n > 0) {
      log.info({ taskName: task.name, projectId: task.project_id }, "project has a running session — deferring scheduled task");
      return { launched: false, reason: "project busy (session running)" };
    }

    // Pre-flight: verify project is ready for autonomous sessions
    if (!existsSync(project.path)) {
      log.warn({ path: project.path, taskName: task.name }, "project path not found, skipping");
      this.alertSkip(task, `project path not found: ${project.path}`);
      return { launched: false, reason: "project path not found" };
    }
    const mcpJson = join(project.path, ".mcp.json");
    if (!existsSync(mcpJson) || !readFileSync(mcpJson, "utf-8").includes("nosleep")) {
      log.warn({ path: project.path }, "missing nosleep gateway in .mcp.json, skipping");
      this.alertSkip(task, "missing nosleep gateway in .mcp.json");
      return { launched: false, reason: "missing nosleep gateway in .mcp.json" };
    }

    log.info({ taskName: task.name, path: project.path }, "launching scheduled task");

    // Get project name and CLAUDE.md context for project-aware goals
    const projectInfo = this.db.prepare(`SELECT name FROM projects WHERE id = ?`).get(project.id) as { name: string } | undefined;
    const projectName = projectInfo?.name ?? "Unknown";

    // Read first 500 chars of CLAUDE.md if it exists for project context
    let projectContext = "";
    try {
      const claudeMd = join(project.path, "CLAUDE.md");
      if (existsSync(claudeMd)) {
        projectContext = readFileSync(claudeMd, "utf-8").slice(0, 500);
      }
    } catch {}

    // Build project-aware goal
    const contextPrefix = projectContext
      ? `Project: ${projectName}\nContext: ${projectContext}\n\n`
      : `Project: ${projectName}\n\n`;

    // strategy_mode decides what work this wake does:
    //   'next_actionable' → pull and execute the next ready strat-tree task
    //                       (this is the time-based loop / scheduled tree
    //                       processor — matches /loop Nm semantics).
    //   'template'        → run the review goal_template (cron reviews).
    let goal: string;
    let acceptanceCriteria: string[];
    let noRetry: boolean;

    if (task.strategy_mode === "next_actionable") {
      // Re-decide at FIRE time via the loop brain so the wake honours the
      // AI-controllable loop config (continue/content/branch, no-progress
      // guard, branch auto-stop, enabled). The loop config may have changed
      // between scheduling this wake and now.
      const decision = resolveLoopDecision(this.db, project.id);
      if (decision.action === "stop") {
        log.info({ taskName: task.name, projectName, reason: decision.reason }, "interval loop woke but the loop says stop — not launching");
        return { launched: false, reason: decision.reason ?? "loop stopped" };
      }
      if (decision.action === "continue" && decision.content) {
        // CONTENT mode — inject the AI-supplied content verbatim.
        goal = `${contextPrefix}${decision.content}`;
        acceptanceCriteria = ["Address the loop instruction above"];
        noRetry = true;
      } else if (decision.nextTask) {
        const t = decision.nextTask;
        goal =
          `${contextPrefix}Continue the autonomous loop for ${projectName}. ` +
          `Work the next strategy-tree task below to completion, following the project's iteration workflow. ` +
          `For parallelizable subtasks (broad searches, multi-file audits, independent modules), delegate to subagents or an agent team instead of grinding serially.\n\n` +
          `[${t.type}] ${t.title}\n${t.description || ""}` +
          (t.acceptanceCriteria.length > 0
            ? `\n\nAcceptance Criteria:\n${t.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`
            : "");
        acceptanceCriteria = t.acceptanceCriteria.length > 0 ? t.acceptanceCriteria : [`Complete: ${t.title}`];
        noRetry = false;
      } else {
        // continue with no task + no content (e.g. in_progress nudge) — nothing
        // concrete to launch; skip this wake.
        log.info({ taskName: task.name, projectName }, "interval loop woke with no concrete task/content — skipping");
        return { launched: false, reason: "no actionable task or content" };
      }
    } else {
      goal = `${contextPrefix}${task.goal_template}\n\nUse nosleep(action="strategy_add") to add findings to the strategy tree. Use nosleep(action="project_search") to search project code and docs. For broad sweeps (many files/dimensions), fan out subagents rather than reviewing serially.`;
      acceptanceCriteria = [
        `Review ${projectName} thoroughly`,
        "Fix any quick wins found (< 5 min each)",
        "Add complex issues to strategy tree via nosleep gateway",
      ];
      noRetry = true; // Reviews find issues, don't retry on incomplete verdict
    }

    const sessionId = this.sessionManager.launch({
      projectId: project.id,
      orgId: project.org_id,
      accountId: project.account_id,
      cwd: project.path,
      goal,
      acceptanceCriteria,
      permissionMode: "auto",
      autonomyLevel: project.autonomy_level as
        | "full"
        | "supervised"
        | "manual",
      noRetry,
      // Loop wakes RESUME the project's last completed session (48h recency
      // bound in getLastClaudeSessionId) so iteration N remembers iteration
      // N-1's context — cheaper via prompt cache, and stalled work carries
      // its rationale forward. Cron reviews stay fresh-context.
      continueSession: task.strategy_mode === "next_actionable",
    });

    // Log scheduled task run
    this.db.prepare(`INSERT INTO session_events (session_id, event_type, payload) VALUES (?, 'scheduled_task_run', ?)`)
      .run(sessionId, JSON.stringify({ taskId: task.id, taskName: task.name, projectId: project.id }));

    return { launched: true };
  }

  /**
   * Poll for the spawned session to complete, then allow next queued task.
   * Hard timeout of TASK_MAX_RUNTIME_MS prevents wedging the queue forever
   * if a session hangs without exiting.
   */
  private watchForCompletion(task: ScheduledTaskRow): void {
    const release = (reason: string): void => {
      clearInterval(check);
      clearTimeout(timeout);
      this.watchHandles.delete(check);
      this.watchTimeouts.delete(timeout);
      if (this.currentTaskRunning) {
        this.currentTaskRunning = false;
        log.info({ taskName: task.name, reason }, "task finished — queue ready for next");
      }
    };

    const check = setInterval(() => {
      const active = this.db.prepare(
        `SELECT COUNT(*) as n FROM sessions WHERE status = 'running' AND id NOT LIKE 'manual_%'`,
      ).get() as { n: number };
      if (active.n === 0) release("completed");
    }, 30_000);

    const timeout = setTimeout(() => {
      release(`exceeded ${TASK_MAX_RUNTIME_MS / 60000}m max runtime — force-released`);
    }, TASK_MAX_RUNTIME_MS);

    this.watchHandles.add(check);
    this.watchTimeouts.add(timeout);
  }

  /**
   * Resolve the next ready strategy-tree task for a project, honouring
   * priority / dependencies / skipped ancestors (same logic decide-next
   * uses for the interactive loop). Marks it in_progress so a follow-up
   * wake doesn't pick the same node again. Returns null if nothing's ready.
   */
  private pickNextActionable(
    projectId: string,
    orgId: string,
  ):
    | { id: string; title: string; description: string; acceptance_criteria: string; type: string }
    | null {
    // Lazy require to avoid a top-level cycle (tree-manager → db → scheduler).
    let node:
      | { id: string; title: string; description: string; acceptanceCriteria: string[]; type: string }
      | null = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
      const { StrategyTreeManager } = require("../strategy/tree-manager.js");
      const tm = new StrategyTreeManager(this.db);
      node = tm.getNextActionable(projectId) ?? null;
    } catch {
      node = null;
    }
    if (!node) return null;

    // Pin it in_progress + tag nothing yet (session id assigned on launch).
    this.db
      .prepare(
        `UPDATE strategy_nodes SET status = 'in_progress', started_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND status = 'pending'`,
      )
      .run(node.id);

    return {
      id: node.id,
      title: node.title,
      description: node.description,
      acceptance_criteria: JSON.stringify(node.acceptanceCriteria ?? []),
      type: node.type,
    };
  }

  /**
   * Manually trigger a specific task immediately. Respects the same
   * 1-at-a-time gate as the tick loop (refuses if a session is already
   * running) and recomputes next_run_at so a manually-run recurring task
   * doesn't immediately re-fire on the next tick (double-fire).
   */
  runTaskById(taskId: string): { launched: boolean; reason?: string } {
    const task = this.db
      .prepare(`SELECT * FROM scheduled_tasks WHERE id = ?`)
      .get(taskId) as ScheduledTaskRow | undefined;

    if (!task) {
      throw new Error(`Scheduled task ${taskId} not found`);
    }

    // Gate: don't launch concurrently with an active session or another
    // queued task — preserves the dead-time / 1-at-a-time invariant.
    // Matches the tick gate: only SPAWNED sessions count. Manual/interactive
    // sessions stay 'running' for days, and counting them made the manual
    // Run button refuse for every project whenever a human was typing in
    // any repo (the same starvation bug the tick gate already fixed).
    const active = this.db.prepare(
      `SELECT COUNT(*) as n FROM sessions WHERE status = 'running' AND id NOT LIKE 'manual_%'`,
    ).get() as { n: number };
    if (active.n > 0 || this.currentTaskRunning) {
      return { launched: false, reason: "a session is already running — try again during dead time" };
    }

    // Drop the task from the pending tick queue so a manual run doesn't
    // double-fire it: the queue holds stale row OBJECTS, so after this run
    // pushes next_run_at forward the next tick would still shift() and run
    // the old copy.
    this.taskQueue = this.taskQueue.filter((t) => t.id !== task.id);

    let result: { launched: boolean; reason?: string };
    try {
      this.currentTaskRunning = true;
      result = this.runTask(task);
      if (result.launched) {
        this.watchForCompletion(task);
      } else {
        this.currentTaskRunning = false;
      }
    } catch (err) {
      this.currentTaskRunning = false;
      result = { launched: false, reason: err instanceof Error ? err.message : String(err) };
    }

    // Recompute schedule (last_run_at only on a real launch; transient
    // oneshot failures reschedule instead of self-consuming).
    this.stampAfterRun(task, result.launched, result.reason ?? "");

    return result;
  }

  /**
   * Seed default tasks for all projects that don't already have scheduled tasks.
   */
  seedDefaults(): void {
    // Skip the per-org Ad-hoc catch-alls: their path (__adhoc__/<org>) is not
    // a real directory, so seeded review tasks can never launch — they just
    // generate scheduled_task_skipped alerts forever.
    const projects = this.db
      .prepare(`SELECT id, org_id FROM projects WHERE path NOT LIKE '__adhoc__/%'`)
      .all() as Array<{ id: string; org_id: string }>;

    let seeded = 0;
    for (const project of projects) {
      const existing = this.db
        .prepare(
          `SELECT COUNT(*) as cnt FROM scheduled_tasks WHERE project_id = ?`,
        )
        .get(project.id) as { cnt: number };

      if (existing.cnt > 0) continue;

      for (const def of DEFAULT_TASKS) {
        const id = nanoid();
        const nextRun = calculateNextRun(
          def.cronHour,
          def.cronMinute,
          def.daysOfWeek,
        );
        this.db
          .prepare(
            `INSERT INTO scheduled_tasks (id, project_id, org_id, name, cron_hour, cron_minute, days_of_week, goal_template, task_type, next_run_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            project.id,
            project.org_id,
            def.name,
            def.cronHour,
            def.cronMinute,
            def.daysOfWeek,
            def.goalTemplate,
            def.taskType,
            nextRun,
          );
      }
      seeded++;
    }

    if (seeded > 0) {
      log.info({ count: seeded }, "seeded default tasks for new projects");
    }
  }
}

export { calculateNextRun, calculateNextIntervalRun, nextRunForTask };
