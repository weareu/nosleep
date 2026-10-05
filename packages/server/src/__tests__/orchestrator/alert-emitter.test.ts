import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import type { Alert } from "@nosleep/shared";
import { emitAlert } from "../../orchestrator/alert-emitter.js";
import { eventBus } from "../../event-bus.js";
import { createTestDb, seedMultiOrg } from "../helpers/db.js";

describe("emitAlert", () => {
  let db: Database.Database;
  let listener: ReturnType<typeof vi.fn<(alert: Alert) => void>>;
  let orgId: string;
  let projectId: string;

  beforeEach(() => {
    db = createTestDb();
    const ids = seedMultiOrg(db);
    orgId = ids.personal.orgId;
    projectId = ids.personal.projectId;
    listener = vi.fn<(alert: Alert) => void>();
    eventBus.on("alert:new", listener);
  });

  afterEach(() => {
    eventBus.off("alert:new", listener);
    db.close();
  });

  it("inserts the alert row and returns its id", () => {
    const id = emitAlert(db, {
      orgId,
      type: "drift",
      severity: "warning",
      message: "drifting away",
    });
    expect(typeof id).toBe("number");
    const row = db.prepare(`SELECT * FROM alerts WHERE id = ?`).get(id) as { message: string; severity: string };
    expect(row.message).toBe("drifting away");
    expect(row.severity).toBe("warning");
  });

  it("emits alert:new on the event bus", () => {
    emitAlert(db, { orgId, type: "test", severity: "info", message: "hi" });
    expect(listener).toHaveBeenCalledTimes(1);
    const arg = listener.mock.calls[0][0] as { message: string; orgId: string };
    expect(arg.message).toBe("hi");
    expect(arg.orgId).toBe(orgId);
  });

  it("accepts optional sessionId and projectId", () => {
    db.prepare(`
      INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash)
      VALUES ('s1', ?, ?, 'acc_personal_max', 'running', 'g', 'h')
    `).run(projectId, orgId);

    const id = emitAlert(db, {
      orgId,
      sessionId: "s1",
      projectId,
      type: "test",
      severity: "info",
      message: "with refs",
    });
    const row = db.prepare(`SELECT session_id, project_id FROM alerts WHERE id = ?`).get(id) as { session_id: string; project_id: string };
    expect(row.session_id).toBe("s1");
    expect(row.project_id).toBe(projectId);
  });

  it("stores null for omitted sessionId/projectId", () => {
    const id = emitAlert(db, { orgId, type: "test", severity: "info", message: "no refs" });
    const row = db.prepare(`SELECT session_id, project_id FROM alerts WHERE id = ?`).get(id) as { session_id: string | null; project_id: string | null };
    expect(row.session_id).toBeNull();
    expect(row.project_id).toBeNull();
  });

  it("the emitted alert has acknowledged=false and ISO timestamp", () => {
    emitAlert(db, { orgId, type: "test", severity: "info", message: "x" });
    const arg = listener.mock.calls[0][0] as { acknowledged: boolean; createdAt: string };
    expect(arg.acknowledged).toBe(false);
    expect(arg.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
