import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, seedTestData } from "../helpers/db.js";
import { getLoopConfig, upsertLoopConfig } from "@nosleep/shared";
import { resolveLoopDecision, NO_PROGRESS_LIMIT } from "../../orchestrator/loop-decision.js";

function node(
  db: Database.Database,
  ids: { orgId: string; projectId: string },
  id: string,
  opts: { title?: string; status?: string; parentId?: string | null; type?: string; sortOrder?: number } = {},
): void {
  db.prepare(
    `INSERT INTO strategy_nodes (id, project_id, org_id, parent_id, type, title, status, depth, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(id, ids.projectId, ids.orgId, opts.parentId ?? null, opts.type ?? "task", opts.title ?? id, opts.status ?? "pending", opts.sortOrder ?? 0);
}

describe("resolveLoopDecision", () => {
  let db: Database.Database;
  let ids: { orgId: string; projectId: string };

  beforeEach(() => {
    db = createTestDb();
    ids = seedTestData(db);
  });
  afterEach(() => db.close());

  it("stops when the loop is disabled (default), with the configured interval", () => {
    const d = resolveLoopDecision(db, ids.projectId);
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/disabled/i);
    expect(d.delayMinutes).toBe(10); // default
  });

  it("content mode injects the content; empty content stops + disables", () => {
    upsertLoopConfig(db, ids.projectId, { enabled: true, mode: "content", content: "Continue the next task.", intervalMinutes: 15 });
    const d = resolveLoopDecision(db, ids.projectId);
    expect(d.action).toBe("continue");
    expect(d.content).toBe("Continue the next task.");
    expect(d.delayMinutes).toBe(15);

    upsertLoopConfig(db, ids.projectId, { content: "   " });
    const d2 = resolveLoopDecision(db, ids.projectId);
    expect(d2.action).toBe("stop");
    expect(getLoopConfig(db, ids.projectId).enabled).toBe(0); // auto-disabled
  });

  it("continue mode hands out the next pending task and marks it in_progress", () => {
    node(db, ids, "t1", { status: "pending", title: "Do thing" });
    upsertLoopConfig(db, ids.projectId, { enabled: true, mode: "continue" });

    const d = resolveLoopDecision(db, ids.projectId);
    expect(d.action).toBe("next_task");
    expect(d.nextTask?.id).toBe("t1");
    const row = db.prepare(`SELECT status FROM strategy_nodes WHERE id='t1'`).get() as { status: string };
    expect(row.status).toBe("in_progress");
  });

  it("stops the loop after NO_PROGRESS_LIMIT iterations stuck on the same in_progress task (anti token-waste)", () => {
    node(db, ids, "stuck", { status: "in_progress", title: "Stuck task" });
    upsertLoopConfig(db, ids.projectId, { enabled: true, mode: "continue" });

    // First (LIMIT - 1) calls keep continuing...
    for (let i = 0; i < NO_PROGRESS_LIMIT - 1; i++) {
      expect(resolveLoopDecision(db, ids.projectId).action).toBe("continue");
    }
    // ...the Nth stops and disables.
    const d = resolveLoopDecision(db, ids.projectId);
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/wasting tokens|no completion/i);
    expect(getLoopConfig(db, ids.projectId).enabled).toBe(0);
  });

  it("stops cleanly when the tree has no pending and no in_progress work", () => {
    node(db, ids, "done", { status: "completed" });
    upsertLoopConfig(db, ids.projectId, { enabled: true, mode: "continue" });
    const d = resolveLoopDecision(db, ids.projectId);
    expect(d.action).toBe("stop");
    expect(d.reason).toMatch(/completed or skipped|nothing left/i);
  });

  it("respects dependencies — does not hand out a task whose FS dependency is unmet", () => {
    // t1 must finish before t2 (FS). Only t1 is actionable until t1 completes.
    node(db, ids, "t1", { status: "pending", title: "First" });
    db.prepare(
      `INSERT INTO strategy_nodes (id, project_id, org_id, parent_id, type, title, status, depth, sort_order, dependencies)
       VALUES ('t2', ?, ?, NULL, 'task', 'Second', 'pending', 0, 1, ?)`,
    ).run(ids.projectId, ids.orgId, JSON.stringify([{ nodeId: "t1", type: "FS" }]));
    upsertLoopConfig(db, ids.projectId, { enabled: true, mode: "continue" });

    // First decision: must be t1 (t2 is blocked on t1).
    const d1 = resolveLoopDecision(db, ids.projectId);
    expect(d1.action).toBe("next_task");
    expect(d1.nextTask?.id).toBe("t1");

    // t1 still in_progress (not complete) → t2's FS dep unmet → no new actionable
    // task; the brain must NOT hand out t2.
    const d2 = resolveLoopDecision(db, ids.projectId);
    expect(d2.nextTask?.id).not.toBe("t2");

    // Complete t1 → t2 becomes actionable.
    db.prepare(`UPDATE strategy_nodes SET status='completed' WHERE id='t1'`).run();
    const d3 = resolveLoopDecision(db, ids.projectId);
    expect(d3.action).toBe("next_task");
    expect(d3.nextTask?.id).toBe("t2");
  });

  it("branch mode drives the linked subtree, then auto-stops when the branch completes", () => {
    node(db, ids, "parent", { type: "goal", status: "in_progress", title: "Branch root" });
    node(db, ids, "child", { parentId: "parent", status: "pending", title: "Branch task" });
    // an UNRELATED pending node outside the branch must be ignored
    node(db, ids, "other", { status: "pending", title: "Other branch task" });
    upsertLoopConfig(db, ids.projectId, { enabled: true, mode: "branch", linkedNodeId: "parent" });

    const d1 = resolveLoopDecision(db, ids.projectId);
    expect(d1.action).toBe("next_task");
    expect(d1.nextTask?.id).toBe("child"); // NOT "other" — scoped to the branch

    // complete the branch's work
    db.prepare(`UPDATE strategy_nodes SET status='completed' WHERE id IN ('parent','child')`).run();
    const d2 = resolveLoopDecision(db, ids.projectId);
    expect(d2.action).toBe("stop");
    expect(d2.reason).toMatch(/branch is complete/i);
    expect(getLoopConfig(db, ids.projectId).enabled).toBe(0); // auto-stopped
  });
});
