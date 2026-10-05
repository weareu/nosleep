import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { TaskScheduler, calculateNextRun } from "../../scheduler/task-scheduler.js";
import { createTestDb, seedTestData } from "../helpers/db.js";
import { nanoid } from "nanoid";

interface FakeSessionManager {
  launch: ReturnType<typeof vi.fn>;
}

function makeFakeSessionManager(): FakeSessionManager {
  return {
    launch: vi.fn(() => `sess_${nanoid(8)}`),
  };
}

function insertScheduledTask(
  db: Database.Database,
  params: {
    projectId: string;
    orgId: string;
    name: string;
    enabled?: number;
    nextRunAt?: string | null;
    cronHour?: number;
    cronMinute?: number;
    daysOfWeek?: string;
  },
): string {
  const id = nanoid();
  db.prepare(
    `INSERT INTO scheduled_tasks (id, project_id, org_id, name, cron_hour, cron_minute, days_of_week, goal_template, task_type, enabled, next_run_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    params.projectId,
    params.orgId,
    params.name,
    params.cronHour ?? 9,
    params.cronMinute ?? 0,
    params.daysOfWeek ?? "1,2,3,4,5",
    "test goal",
    "review",
    params.enabled ?? 1,
    params.nextRunAt ?? null,
  );
  return id;
}

describe("TaskScheduler.start clamps past-due tasks", () => {
  let db: Database.Database;
  let scheduler: TaskScheduler;
  let sm: FakeSessionManager;

  beforeEach(() => {
    db = createTestDb();
    sm = makeFakeSessionManager();
    scheduler = new TaskScheduler(db, sm as never);
  });

  afterEach(() => {
    scheduler.stop();
    db.close();
  });

  it("clamps a single past-due task to a future time on start", () => {
    const { orgId, projectId } = seedTestData(db);
    const yesterday = new Date(Date.now() - 86400_000).toISOString();
    const taskId = insertScheduledTask(db, {
      projectId,
      orgId,
      name: "Stale Task",
      nextRunAt: yesterday,
    });

    scheduler.start();

    const after = db
      .prepare(`SELECT next_run_at FROM scheduled_tasks WHERE id = ?`)
      .get(taskId) as { next_run_at: string };
    expect(new Date(after.next_run_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("clamps many past-due tasks (the 72-task pileup scenario)", () => {
    const { orgId, projectId } = seedTestData(db);
    const ancient = "2020-01-01T00:00:00.000Z";
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push(
        insertScheduledTask(db, {
          projectId,
          orgId,
          name: `Task ${i}`,
          nextRunAt: ancient,
        }),
      );
    }

    scheduler.start();

    const futures = db
      .prepare(`SELECT next_run_at FROM scheduled_tasks WHERE id IN (${ids.map(() => "?").join(",")})`)
      .all(...ids) as { next_run_at: string }[];

    expect(futures).toHaveLength(20);
    for (const row of futures) {
      expect(new Date(row.next_run_at).getTime()).toBeGreaterThan(Date.now());
    }
  });

  it("does not clamp future-scheduled tasks", () => {
    const { orgId, projectId } = seedTestData(db);
    const tomorrow = new Date(Date.now() + 86400_000).toISOString();
    const taskId = insertScheduledTask(db, {
      projectId,
      orgId,
      name: "Future Task",
      nextRunAt: tomorrow,
    });

    scheduler.start();

    const after = db
      .prepare(`SELECT next_run_at FROM scheduled_tasks WHERE id = ?`)
      .get(taskId) as { next_run_at: string };
    expect(after.next_run_at).toBe(tomorrow);
  });

  it("ignores disabled past-due tasks", () => {
    const { orgId, projectId } = seedTestData(db);
    const yesterday = new Date(Date.now() - 86400_000).toISOString();
    const taskId = insertScheduledTask(db, {
      projectId,
      orgId,
      name: "Disabled Task",
      enabled: 0,
      nextRunAt: yesterday,
    });

    scheduler.start();

    const after = db
      .prepare(`SELECT next_run_at FROM scheduled_tasks WHERE id = ?`)
      .get(taskId) as { next_run_at: string };
    expect(after.next_run_at).toBe(yesterday);
  });

  it("ignores tasks with null next_run_at", () => {
    const { orgId, projectId } = seedTestData(db);
    const taskId = insertScheduledTask(db, {
      projectId,
      orgId,
      name: "Null Task",
      nextRunAt: null,
    });

    scheduler.start();

    const after = db
      .prepare(`SELECT next_run_at FROM scheduled_tasks WHERE id = ?`)
      .get(taskId) as { next_run_at: string | null };
    expect(after.next_run_at).toBeNull();
  });
});

describe("TaskScheduler.stop clears all timers", () => {
  let db: Database.Database;
  let scheduler: TaskScheduler;

  beforeEach(() => {
    db = createTestDb();
    scheduler = new TaskScheduler(db, makeFakeSessionManager() as never);
  });

  afterEach(() => {
    db.close();
  });

  it("stop is idempotent", () => {
    scheduler.start();
    scheduler.stop();
    scheduler.stop(); // should not throw
    expect(true).toBe(true);
  });

  it("stop clears currentTaskRunning flag", () => {
    scheduler.start();
    // Force the flag on by simulating mid-task state
    (scheduler as unknown as { currentTaskRunning: boolean }).currentTaskRunning = true;
    scheduler.stop();
    expect(
      (scheduler as unknown as { currentTaskRunning: boolean }).currentTaskRunning,
    ).toBe(false);
  });
});

describe("calculateNextRun returns future time", () => {
  it("returns ISO string in the future for weekday cron", () => {
    const next = calculateNextRun(9, 0, "1,2,3,4,5");
    expect(new Date(next).getTime()).toBeGreaterThan(Date.now());
  });

  it("handles single-day cron", () => {
    const next = calculateNextRun(14, 30, "3"); // Wednesdays only
    const d = new Date(next);
    expect(d.getDay()).toBe(3);
  });

  it("handles weekend cron", () => {
    const next = calculateNextRun(10, 0, "0,6"); // Sat/Sun
    const d = new Date(next);
    expect([0, 6]).toContain(d.getDay());
  });
});
