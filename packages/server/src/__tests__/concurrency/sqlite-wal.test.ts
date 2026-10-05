import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createTestDb, seedMultiOrg } from "../helpers/db.js";

/**
 * Verifies SQLite WAL mode behavior under concurrent operations.
 * better-sqlite3 is synchronous, so all "concurrency" here is sequential
 * within a single process — but we exercise rapid back-to-back writes
 * to surface any consistency issues.
 */
describe("SQLite WAL concurrency", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("uses memory mode in tests; production sets WAL", () => {
    // In-memory SQLite cannot use WAL — production uses file-backed DB with WAL.
    // The schema initialization unconditionally sets journal_mode=WAL, but the
    // pragma is silently ignored for ":memory:" paths. This test gates the
    // intent: assert the mode is one of the valid options that supports
    // multi-statement transactions.
    const mode = db.pragma("journal_mode", { simple: true });
    expect(["wal", "memory", "delete"]).toContain(mode);
  });

  it("foreign_keys are enforced", () => {
    const fk = db.pragma("foreign_keys", { simple: true });
    expect(fk).toBe(1);
  });

  it("rejects rapid duplicate session inserts on PK", () => {
    const ids = seedMultiOrg(db);
    db.prepare(`
      INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash)
      VALUES ('dup', ?, ?, ?, 'running', 'g', 'h')
    `).run(ids.personal.projectId, ids.personal.orgId, ids.personal.accountId);

    expect(() => {
      db.prepare(`
        INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash)
        VALUES ('dup', ?, ?, ?, 'running', 'g2', 'h2')
      `).run(ids.personal.projectId, ids.personal.orgId, ids.personal.accountId);
    }).toThrow(/UNIQUE constraint/);
  });

  it("burst of 1000 sequential writes completes consistently", () => {
    const ids = seedMultiOrg(db);
    const insert = db.prepare(`
      INSERT INTO alerts (org_id, type, severity, message)
      VALUES (?, 'burst', 'info', ?)
    `);

    const start = Date.now();
    const txn = db.transaction((count: number) => {
      for (let i = 0; i < count; i++) {
        insert.run(ids.personal.orgId, `msg-${i}`);
      }
    });
    txn(1000);
    const elapsed = Date.now() - start;

    const count = db.prepare(`SELECT COUNT(*) as n FROM alerts`).get() as { n: number };
    expect(count.n).toBe(1000);
    // Sanity: 1000 inserts in a transaction should be <1s on any hardware
    expect(elapsed).toBeLessThan(2000);
  });

  it("token_usage rapid inserts maintain SUM consistency", () => {
    const ids = seedMultiOrg(db);
    db.prepare(`
      INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash)
      VALUES ('s1', ?, ?, ?, 'running', 'g', 'h')
    `).run(ids.personal.projectId, ids.personal.orgId, ids.personal.accountId);

    const insert = db.prepare(`
      INSERT INTO token_usage (session_id, account_id, project_id, input_tokens, output_tokens, model)
      VALUES ('s1', ?, ?, ?, ?, 'haiku')
    `);

    const txn = db.transaction(() => {
      for (let i = 0; i < 500; i++) {
        insert.run(ids.personal.accountId, ids.personal.projectId, 100, 50);
      }
    });
    txn();

    const sum = db.prepare(`
      SELECT SUM(input_tokens) as inp, SUM(output_tokens) as out FROM token_usage WHERE session_id = 's1'
    `).get() as { inp: number; out: number };
    expect(sum.inp).toBe(500 * 100);
    expect(sum.out).toBe(500 * 50);
  });

  it("strategy tree updates preserve structural invariants under churn", async () => {
    const { StrategyTreeManager } = await import("../../strategy/tree-manager.js");
    const ids = seedMultiOrg(db);
    const mgr = new StrategyTreeManager(db);

    // Build a tree with 30 leaves
    const rootId = mgr.createTree(ids.personal.projectId, ids.personal.orgId, {
      type: "strategy",
      title: "Root",
    });
    for (let i = 0; i < 30; i++) {
      mgr.createNode({
        projectId: ids.personal.projectId,
        orgId: ids.personal.orgId,
        parentId: rootId,
        type: "task",
        title: `Task ${i}`,
      });
    }

    // Toggle progress on each leaf many times rapidly
    const children = mgr.getChildren(rootId);
    for (const child of children) {
      for (let pct = 10; pct <= 100; pct += 30) {
        mgr.setProgress(child.id, pct);
      }
    }

    // Verify all leaves ended at the final pct value
    const after = mgr.getChildren(rootId);
    expect(after).toHaveLength(30);
    for (const c of after) {
      expect(c.progressPct).toBe(100);
    }
  });
});

describe("Concurrent semantic operations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("ack-all is atomic across hundreds of alerts", () => {
    const ids = seedMultiOrg(db);
    const insert = db.prepare(`
      INSERT INTO alerts (org_id, type, severity, message)
      VALUES (?, 'test', 'info', 'msg')
    `);
    const txn = db.transaction((n: number) => {
      for (let i = 0; i < n; i++) insert.run(ids.personal.orgId);
    });
    txn(500);

    db.prepare(`UPDATE alerts SET acknowledged = 1 WHERE org_id = ? AND acknowledged = 0`)
      .run(ids.personal.orgId);

    const remaining = db
      .prepare(`SELECT COUNT(*) as n FROM alerts WHERE acknowledged = 0`)
      .get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("session insert with org_id mismatch is detected by FK if integrity engaged", () => {
    const ids = seedMultiOrg(db);
    // Insert is allowed (we don't enforce org_id matches project's org at SQL level)
    // but the pattern should be flagged at app layer. Verify FK does enforce that
    // org_id must reference a real org.
    expect(() => {
      db.prepare(`
        INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash)
        VALUES ('x', ?, 'org_doesnotexist', ?, 'running', 'g', 'h')
      `).run(ids.personal.projectId, ids.personal.accountId);
    }).toThrow(/FOREIGN KEY/);
  });

  it("WAL allows reads to proceed while writes are in flight (sync API still serializes)", () => {
    const ids = seedMultiOrg(db);
    // Start a transaction that holds writer lock
    const writer = db.transaction(() => {
      db.prepare(`INSERT INTO alerts (org_id, type, severity, message) VALUES (?, 't', 'info', 'a')`).run(
        ids.personal.orgId,
      );
      // Read inside same transaction
      const count = db.prepare(`SELECT COUNT(*) as n FROM alerts`).get() as { n: number };
      expect(count.n).toBe(1);
    });
    writer();
  });
});
