import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
    status?: string;
    pid?: number | null;
  },
): void {
  db.prepare(`
    INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash, pid)
    VALUES (?, ?, ?, ?, ?, 'g', 'h', ?)
  `).run(
    params.id,
    params.projectId,
    params.orgId,
    params.accountId,
    params.status ?? "running",
    params.pid ?? null,
  );
}

describe("Stale managed session reaper", () => {
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
    (scheduler as unknown as { tick: () => void }).tick();
  }

  it("reaps a managed session whose PID no longer exists", () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "managed_dead",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      pid: 99_999_999, // way above any real PID — guaranteed ESRCH
    });

    tick();

    const row = db.prepare(`SELECT status FROM sessions WHERE id = ?`).get("managed_dead") as { status: string };
    expect(row.status).toBe("failed");
  });

  it("creates an alert when reaping a stale session", () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "managed_dead2",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      pid: 99_999_999,
    });

    tick();

    const alert = db
      .prepare(`SELECT type, severity, message, session_id FROM alerts WHERE session_id = ?`)
      .get("managed_dead2") as { type: string; severity: string; message: string; session_id: string } | undefined;
    expect(alert).toBeDefined();
    expect(alert!.type).toBe("stale_session_reaped");
    expect(alert!.severity).toBe("warning");
    expect(alert!.message).toContain("managed_dea");
    expect(alert!.message).toContain("99999999");
  });

  it("preserves a managed session whose PID is still alive", () => {
    const ids = seedMultiOrg(db);
    // Use the current process PID — guaranteed to be alive
    insertSession(db, {
      id: "managed_alive",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      pid: process.pid,
    });

    tick();

    const row = db.prepare(`SELECT status FROM sessions WHERE id = ?`).get("managed_alive") as { status: string };
    expect(row.status).toBe("running");
  });

  it("does not touch manual sessions (null PID)", () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "manual_no_pid",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      pid: null,
    });

    tick();

    const row = db.prepare(`SELECT status FROM sessions WHERE id = ?`).get("manual_no_pid") as { status: string };
    expect(row.status).toBe("running");
    // No reaper alert
    const alerts = db.prepare(`SELECT COUNT(*) as n FROM alerts WHERE session_id = ?`).get("manual_no_pid") as { n: number };
    expect(alerts.n).toBe(0);
  });

  it("ignores non-running sessions even with dead PID", () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "already_completed",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      status: "completed",
      pid: 99_999_999,
    });

    tick();

    const row = db.prepare(`SELECT status FROM sessions WHERE id = ?`).get("already_completed") as { status: string };
    expect(row.status).toBe("completed");
  });

  it("reaps multiple dead sessions in a single tick", () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "d1",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      pid: 99_999_999,
    });
    insertSession(db, {
      id: "d2",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      pid: 99_999_998,
    });
    insertSession(db, {
      id: "alive",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      pid: process.pid,
    });

    tick();

    const d1 = db.prepare(`SELECT status FROM sessions WHERE id = 'd1'`).get() as { status: string };
    const d2 = db.prepare(`SELECT status FROM sessions WHERE id = 'd2'`).get() as { status: string };
    const alive = db.prepare(`SELECT status FROM sessions WHERE id = 'alive'`).get() as { status: string };
    expect(d1.status).toBe("failed");
    expect(d2.status).toBe("failed");
    expect(alive.status).toBe("running");
  });

  it("treats invalid PIDs (zero or negative) as dead", () => {
    const ids = seedMultiOrg(db);
    insertSession(db, {
      id: "bad_pid",
      projectId: ids.personal.projectId,
      orgId: ids.personal.orgId,
      accountId: ids.personal.accountId,
      pid: 0, // invalid
    });

    tick();

    const row = db.prepare(`SELECT status FROM sessions WHERE id = ?`).get("bad_pid") as { status: string };
    expect(row.status).toBe("failed");
  });
});
