/**
 * Phase 12 — regression test for the peer.id.slice crash on the
 * Coordination dashboard. Ensures /api/coordination/peers returns
 * snake_case fields + org metadata that the web client expects.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { Coordinator } from "../coordination/coordinator.js";
import { runMigrations } from "../db/migrations.js";
import { MIGRATIONS } from "../db/migrations-list.js";

let db: Database.Database;
let coord: Coordinator;

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db, MIGRATIONS);

  // Seed an org, project, account, session.
  // org_personal seeded by migrations (slug CHECK constraint allowlists
  // only personal|wyobi|apply). Override the colour for assertion clarity.
  db.prepare(
    `UPDATE organizations SET color = '#abcdef' WHERE id = 'org_personal'`,
  ).run();
  db.prepare(
    `INSERT INTO accounts (id, org_id, name, type)
     VALUES ('acc_test', 'org_personal', 'Test Account', 'pro')`,
  ).run();
  db.prepare(
    `INSERT INTO projects (id, org_id, name, path, account_id, token_budget, autonomy_level, status)
     VALUES ('proj_test', 'org_personal', 'Test Proj', '/tmp/test', 'acc_test', 1000000, 'supervised', 'idle')`,
  ).run();
  db.prepare(
    `INSERT INTO sessions (id, project_id, account_id, status, goal_text, goal_hash)
     VALUES ('sess_test', 'proj_test', 'acc_test', 'running', 'do thing', 'abc')`,
  ).run();

  coord = new Coordinator(db);
});

afterAll(() => {
  db.close();
});

describe("phase 12 — coordination peer shape (regression for peer.id.slice)", () => {
  test("getActivePeers returns snake_case keys + org_id/name/color", () => {
    const peers = coord.getActivePeers();
    expect(peers.length).toBe(1);
    const p = peers[0];

    // ── Web Coordination component expects every one of these:
    expect(p.id).toBe("sess_test");
    expect(p.project_id).toBe("proj_test");
    expect(p.project_name).toBe("Test Proj");
    expect(p.goal_text).toBe("do thing");
    expect(p.status).toBe("running");
    expect(typeof p.started_at).toBe("string");
    expect(p.org_id).toBe("org_personal");
    expect(p.org_name).toBe("Personal");
    expect(p.org_color).toBe("#abcdef");

    // ── Old camelCase keys must NOT appear (would silently re-introduce
    // the previous crash).
    const flat = p as unknown as Record<string, unknown>;
    expect(flat.sessionId).toBeUndefined();
    expect(flat.projectName).toBeUndefined();
    expect(flat.goalText).toBeUndefined();
    expect(flat.startedAt).toBeUndefined();
  });

  test("orgId filter scopes results", () => {
    const all = coord.getActivePeers();
    const matching = coord.getActivePeers("org_personal");
    const nonMatching = coord.getActivePeers("org_other");
    expect(all.length).toBe(1);
    expect(matching.length).toBe(1);
    expect(nonMatching.length).toBe(0);
  });
});
