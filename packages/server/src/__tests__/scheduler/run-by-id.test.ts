import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskScheduler } from "../../scheduler/task-scheduler.js";
import { createTestDb, seedTestData } from "../helpers/db.js";
import { nanoid } from "nanoid";

// The fake mirrors the real sessionManager.launch contract: it inserts a
// 'running' sessions row (so the session_events FK in runTask resolves) and
// returns its id.
function makeFakeSessionManager(db: Database.Database) {
  return {
    launch: vi.fn((opts: { projectId: string; orgId: string; accountId: string }) => {
      const id = `sess_${nanoid(8)}`;
      db.prepare(
        `INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash, started_at, last_activity_at)
         VALUES (?, ?, ?, ?, 'running', 'g', 'h', datetime('now'), datetime('now'))`,
      ).run(id, opts.projectId, opts.orgId, opts.accountId);
      return id;
    }),
  };
}

function insertTask(
  db: Database.Database,
  p: { projectId: string; orgId: string; nextRunAt?: string | null; oneshot?: number },
): string {
  const id = nanoid();
  db.prepare(
    `INSERT INTO scheduled_tasks (id, project_id, org_id, name, cron_hour, cron_minute, days_of_week, goal_template, task_type, enabled, next_run_at, oneshot)
     VALUES (?, ?, ?, ?, 9, 0, '1,2,3,4,5', 'review the project', 'review', 1, ?, ?)`,
  ).run(id, p.projectId, p.orgId, "Manual Task", p.nextRunAt ?? null, p.oneshot ?? 0);
  return id;
}

describe("runTaskById (manual schedule_run)", () => {
  let db: Database.Database;
  let scheduler: TaskScheduler;
  let sm: ReturnType<typeof makeFakeSessionManager>;

  beforeEach(() => {
    db = createTestDb();
    sm = makeFakeSessionManager(db);
    scheduler = new TaskScheduler(db, sm as never);
  });

  afterEach(() => {
    scheduler.stop();
    db.close();
  });

  it("refuses to launch while a session is already running (1-at-a-time gate)", () => {
    const { orgId, projectId, accountId } = seedTestData(db);
    db.prepare(
      `INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash, started_at, last_activity_at)
       VALUES (?, ?, ?, ?, 'running', 'g', 'h', datetime('now'), datetime('now'))`,
    ).run(`sess_${nanoid(6)}`, projectId, orgId, accountId);

    const taskId = insertTask(db, { orgId, projectId });
    const result = scheduler.runTaskById(taskId);

    expect(result.launched).toBe(false);
    expect(result.reason).toMatch(/already running|dead time/i);
    expect(sm.launch).not.toHaveBeenCalled();
  });

  it("on a misconfigured project: alerts, does not stamp last_run_at, returns launched=false", () => {
    // seedTestData points the project at /tmp/test-project (does not exist) →
    // runTask skips at the path pre-flight.
    const { orgId, projectId } = seedTestData(db);
    const taskId = insertTask(db, { orgId, projectId });

    const result = scheduler.runTaskById(taskId);

    expect(result.launched).toBe(false);
    expect(sm.launch).not.toHaveBeenCalled();

    const alert = db
      .prepare(`SELECT * FROM alerts WHERE type = 'scheduled_task_skipped' AND project_id = ?`)
      .get(projectId) as { message: string } | undefined;
    expect(alert).toBeDefined();
    expect(alert!.message).toMatch(/did not launch/i);

    const row = db
      .prepare(`SELECT last_run_at FROM scheduled_tasks WHERE id = ?`)
      .get(taskId) as { last_run_at: string | null };
    expect(row.last_run_at).toBeNull(); // a skip must NOT look like a success
  });

  it("on a real launch: stamps last_run_at and advances next_run_at (no double-fire)", () => {
    const dir = mkdtempSync(join(tmpdir(), "nosleep-sched-"));
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { nosleep: {} } }));
    try {
      const orgId = "org_personal";
      db.prepare(
        `INSERT INTO accounts (id, org_id, name, type, daily_token_limit, monthly_token_limit)
         VALUES ('acc_x', ?, 'A', 'max', 1000000, 30000000)`,
      ).run(orgId);
      const projectId = "proj_real";
      db.prepare(
        `INSERT INTO projects (id, org_id, name, path, account_id, token_budget, autonomy_level)
         VALUES (?, ?, 'Real', ?, 'acc_x', 500000, 'full')`,
      ).run(projectId, orgId, dir);

      const pastDue = "2020-01-01T00:00:00.000Z";
      const taskId = insertTask(db, { orgId, projectId, nextRunAt: pastDue });

      const result = scheduler.runTaskById(taskId);

      expect(result.launched).toBe(true);
      expect(sm.launch).toHaveBeenCalledTimes(1);

      const row = db
        .prepare(`SELECT last_run_at, next_run_at FROM scheduled_tasks WHERE id = ?`)
        .get(taskId) as { last_run_at: string | null; next_run_at: string };
      expect(row.last_run_at).not.toBeNull();
      // next_run_at must move to the future so the next tick doesn't re-fire it.
      expect(new Date(row.next_run_at).getTime()).toBeGreaterThan(Date.now());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
