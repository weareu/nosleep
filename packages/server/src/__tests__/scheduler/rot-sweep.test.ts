import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { TaskScheduler } from "../../scheduler/task-scheduler.js";
import { createTestDb, seedTestData } from "../helpers/db.js";

function node(db: Database.Database, ids: { orgId: string; projectId: string }, id: string, opts: { status?: string; updatedAt?: string; parentId?: string | null } = {}): void {
  db.prepare(
    `INSERT INTO strategy_nodes (id, project_id, org_id, parent_id, type, title, status, depth, sort_order, updated_at)
     VALUES (?, ?, ?, ?, 'task', ?, ?, 0, 0, ?)`,
  ).run(id, ids.projectId, ids.orgId, opts.parentId ?? null, id, opts.status ?? "in_progress", opts.updatedAt ?? "2026-03-01 00:00:00");
}

describe("strategy rot sweeper", () => {
  let db: Database.Database;
  let scheduler: TaskScheduler;
  let ids: { orgId: string; projectId: string; accountId: string };

  beforeEach(() => {
    db = createTestDb();
    ids = seedTestData(db);
    scheduler = new TaskScheduler(db, { launch: vi.fn() } as never);
  });
  afterEach(() => {
    scheduler.stop();
    db.close();
  });

  function tick(): void {
    (scheduler as unknown as { tick: () => void }).tick();
  }

  it("demotes stale in_progress leaves to pending and raises one summary alert", () => {
    node(db, ids, "rotted");
    tick();
    const row = db.prepare(`SELECT status FROM strategy_nodes WHERE id='rotted'`).get() as { status: string };
    expect(row.status).toBe("pending");
    const alert = db.prepare(`SELECT message FROM alerts WHERE type='strategy_rot_swept'`).get() as { message: string };
    expect(alert.message).toMatch(/1 in_progress task/);
  });

  it("leaves recently-touched and session-assigned nodes alone", () => {
    node(db, ids, "fresh", { updatedAt: new Date().toISOString().replace("T", " ").slice(0, 19) });
    node(db, ids, "working");
    db.prepare(
      `INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash, strategy_node_id, started_at, last_activity_at)
       VALUES ('s1', ?, ?, ?, 'running', 'g', 'h', 'working', datetime('now'), datetime('now'))`,
    ).run(ids.projectId, ids.orgId, ids.accountId);
    tick();
    expect((db.prepare(`SELECT status FROM strategy_nodes WHERE id='fresh'`).get() as { status: string }).status).toBe("in_progress");
    expect((db.prepare(`SELECT status FROM strategy_nodes WHERE id='working'`).get() as { status: string }).status).toBe("in_progress");
  });

  it("does not demote parent nodes (their status is derived from children)", () => {
    node(db, ids, "parent");
    node(db, ids, "child", { parentId: "parent", status: "completed" });
    tick();
    expect((db.prepare(`SELECT status FROM strategy_nodes WHERE id='parent'`).get() as { status: string }).status).toBe("in_progress");
  });
});
