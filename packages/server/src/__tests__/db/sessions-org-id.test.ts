import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, seedMultiOrg } from "../helpers/db.js";

describe("sessions.org_id column", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("exists on the sessions table", () => {
    const cols = db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{
      name: string;
      type: string;
    }>;
    const orgIdCol = cols.find((c) => c.name === "org_id");
    expect(orgIdCol).toBeDefined();
    expect(orgIdCol!.type).toBe("TEXT");
  });

  it("has an index for fast org filtering", () => {
    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sessions'`)
      .all() as Array<{ name: string }>;
    expect(indexes.find((i) => i.name === "idx_sessions_org")).toBeDefined();
  });

  it("backfills org_id from projects on migration for legacy rows", () => {
    // Seed projects via the helper, then insert a session WITHOUT org_id (simulating pre-migration data)
    const { personal } = seedMultiOrg(db);
    db.prepare(`
      INSERT INTO sessions (id, project_id, account_id, status, goal_text, goal_hash, org_id)
      VALUES (?, ?, ?, 'running', 'legacy', 'h', NULL)
    `).run("legacy_sess", personal.projectId, personal.accountId);

    // Re-run the backfill statement (idempotent) — represents the migration logic
    db.prepare(`UPDATE sessions SET org_id = (SELECT p.org_id FROM projects p WHERE p.id = sessions.project_id) WHERE org_id IS NULL`).run();

    const row = db
      .prepare(`SELECT org_id FROM sessions WHERE id = ?`)
      .get("legacy_sess") as { org_id: string };
    expect(row.org_id).toBe(personal.orgId);
  });

  it("supports direct org filtering without JOIN through projects", () => {
    const { personal, work } = seedMultiOrg(db);
    db.prepare(`
      INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash)
      VALUES (?, ?, ?, ?, 'running', 'g1', 'h1')
    `).run("s_p1", personal.projectId, personal.orgId, personal.accountId);
    db.prepare(`
      INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash)
      VALUES (?, ?, ?, ?, 'running', 'g2', 'h2')
    `).run("s_w1", work.projectId, work.orgId, work.accountId);

    const personalSessions = db
      .prepare(`SELECT id FROM sessions WHERE org_id = ?`)
      .all(personal.orgId) as Array<{ id: string }>;
    expect(personalSessions).toHaveLength(1);
    expect(personalSessions[0].id).toBe("s_p1");

    const workSessions = db
      .prepare(`SELECT id FROM sessions WHERE org_id = ?`)
      .all(work.orgId) as Array<{ id: string }>;
    expect(workSessions).toHaveLength(1);
    expect(workSessions[0].id).toBe("s_w1");
  });

  it("goal_progress style query no longer has ambiguous id column", () => {
    const { personal } = seedMultiOrg(db);
    db.prepare(`
      INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash)
      VALUES (?, ?, ?, ?, 'running', 'g', 'h')
    `).run("s1", personal.projectId, personal.orgId, personal.accountId);
    db.prepare(`
      INSERT INTO goals (id, session_id, project_id, objective)
      VALUES (?, ?, ?, ?)
    `).run("goal1", "s1", personal.projectId, "test");

    // The new query — uses sessions.org_id, aliases goal id as goal_id (no ambiguity)
    const goal = db.prepare(`
      SELECT g.id AS goal_id, g.acceptance_criteria
      FROM goals g
      JOIN sessions s ON g.session_id = s.id
      WHERE g.session_id = ? AND s.org_id = ?
      ORDER BY g.created_at DESC LIMIT 1
    `).get("s1", personal.orgId) as { goal_id: string; acceptance_criteria: string } | undefined;

    expect(goal).toBeDefined();
    expect(goal!.goal_id).toBe("goal1");
  });
});
