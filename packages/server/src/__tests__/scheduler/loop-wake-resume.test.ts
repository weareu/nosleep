import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { TaskScheduler } from "../../scheduler/task-scheduler.js";
import { createTestDb } from "../helpers/db.js";
import { upsertLoopConfig } from "@nosleep/shared";

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

describe("loop wakes resume the previous session (Task 3)", () => {
  let db: Database.Database;
  let scheduler: TaskScheduler;
  let sm: ReturnType<typeof makeFakeSessionManager>;
  let dir: string;
  const projectId = "proj_resume";

  beforeEach(() => {
    db = createTestDb();
    dir = mkdtempSync(join(tmpdir(), "nosleep-resume-"));
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { nosleep: {} } }));
    db.prepare(
      `INSERT INTO accounts (id, org_id, name, type, daily_token_limit, monthly_token_limit)
       VALUES ('acc_r', 'org_personal', 'A', 'max', 1000000, 30000000)`,
    ).run();
    db.prepare(
      `INSERT INTO projects (id, org_id, name, path, account_id, token_budget, autonomy_level)
       VALUES (?, 'org_personal', 'R', ?, 'acc_r', 500000, 'full')`,
    ).run(projectId, dir);
    sm = makeFakeSessionManager(db);
    scheduler = new TaskScheduler(db, sm as never);
  });

  afterEach(() => {
    scheduler.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function insertTask(strategyMode: "next_actionable" | "template"): string {
    const id = nanoid();
    db.prepare(
      `INSERT INTO scheduled_tasks (id, project_id, org_id, name, cron_hour, cron_minute, days_of_week, goal_template, task_type, enabled, next_run_at, oneshot, strategy_mode, mode)
       VALUES (?, ?, 'org_personal', 'T', 9, 0, '1,2,3,4,5', 'review it', 'review', 1, NULL, 1, ?, 'interval')`,
    ).run(id, projectId, strategyMode);
    return id;
  }

  it("a loop wake (next_actionable) launches with continueSession=true", () => {
    upsertLoopConfig(db, projectId, { enabled: true, mode: "continue" });
    db.prepare(
      `INSERT INTO strategy_nodes (id, project_id, org_id, parent_id, type, title, status, depth, sort_order)
       VALUES ('n1', ?, 'org_personal', NULL, 'task', 'Work', 'pending', 0, 0)`,
    ).run(projectId);

    const result = scheduler.runTaskById(insertTask("next_actionable"));
    expect(result.launched).toBe(true);
    const opts = sm.launch.mock.calls[0][0] as { continueSession?: boolean };
    expect(opts.continueSession).toBe(true);
  });

  it("a cron review (template) launches WITHOUT resume (fresh context)", () => {
    const result = scheduler.runTaskById(insertTask("template"));
    expect(result.launched).toBe(true);
    const opts = sm.launch.mock.calls[0][0] as { continueSession?: boolean };
    expect(opts.continueSession).toBe(false);
  });
});
