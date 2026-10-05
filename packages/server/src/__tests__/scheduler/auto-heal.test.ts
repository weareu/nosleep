import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { TaskScheduler } from "../../scheduler/task-scheduler.js";
import { createTestDb, seedMultiOrg } from "../helpers/db.js";

function fakeSessionManager() {
  return { launch: vi.fn(() => "stub") } as unknown as ConstructorParameters<typeof TaskScheduler>[1];
}

function insertSession(
  db: Database.Database,
  params: {
    id: string;
    projectId: string;
    orgId: string;
    accountId: string;
    status: string;
    startedAt?: string;
    lastActivityAt?: string;
  },
): void {
  db.prepare(`
    INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash, started_at, last_activity_at)
    VALUES (?, ?, ?, ?, ?, 'g', 'h', ?, ?)
  `).run(
    params.id,
    params.projectId,
    params.orgId,
    params.accountId,
    params.status,
    params.startedAt ?? new Date().toISOString().replace("T", " ").slice(0, 19),
    params.lastActivityAt ?? new Date().toISOString().replace("T", " ").slice(0, 19),
  );
}

describe("Auto-heal: session recovery via scheduler tick", () => {
  let db: Database.Database;
  let scheduler: TaskScheduler;

  beforeEach(() => {
    db = createTestDb();
    scheduler = new TaskScheduler(db, fakeSessionManager());
  });

  afterEach(() => {
    scheduler.stop();
    db.close();
  });

  function tick(): void {
    // Call the private tick directly via cast — public API has no manual trigger
    (scheduler as unknown as { tick: () => void }).tick();
  }

  it("marks 3-hour-old manual sessions as stopped", () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "manual_old",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      status: "running",
      lastActivityAt: "2024-01-01 00:00:00",
    });

    tick();

    const row = db.prepare(`SELECT status FROM sessions WHERE id = ?`).get("manual_old") as { status: string };
    expect(row.status).toBe("stopped");
  });

  it("preserves recently-active manual sessions", () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "manual_fresh",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      status: "running",
      lastActivityAt: new Date().toISOString().replace("T", " ").slice(0, 19),
    });

    tick();

    const row = db.prepare(`SELECT status FROM sessions WHERE id = ?`).get("manual_fresh") as { status: string };
    expect(row.status).toBe("running");
  });

  it("marks spawned sessions idle for 5 hours as failed", () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "spawn_old",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      status: "running",
      lastActivityAt: "2024-01-01 00:00:00",
    });

    tick();

    const row = db.prepare(`SELECT status FROM sessions WHERE id = ?`).get("spawn_old") as { status: string };
    expect(row.status).toBe("failed");
  });

  it("marks sessions stuck in 'starting' for >10min as failed", () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "spawn_stuck",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      status: "starting",
      startedAt: "2024-01-01 00:00:00",
    });

    tick();

    const row = db.prepare(`SELECT status FROM sessions WHERE id = ?`).get("spawn_stuck") as { status: string };
    expect(row.status).toBe("failed");
  });

  it("does NOT mark recent 'starting' sessions as failed", () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "spawn_starting_fresh",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      status: "starting",
      startedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
    });

    tick();

    const row = db.prepare(`SELECT status FROM sessions WHERE id = ?`).get("spawn_starting_fresh") as { status: string };
    expect(row.status).toBe("starting");
  });

  it("stops sessions whose project was deactivated", () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "abandoned",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      status: "running",
    });
    db.prepare(`UPDATE projects SET active = 0 WHERE id = ?`).run(ids.personal.projectId);

    tick();

    const row = db.prepare(`SELECT status FROM sessions WHERE id = ?`).get("abandoned") as { status: string };
    expect(row.status).toBe("stopped");
  });
});
