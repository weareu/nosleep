import { describe, it, expect, beforeEach } from "vitest";
import { TokenTracker } from "../../budget/token-tracker.js";
import { createTestDb, seedTestData } from "../helpers/db.js";
import type Database from "better-sqlite3";

function createSession(
  db: Database.Database,
  id: string,
  projectId: string,
  accountId: string,
): void {
  // Look up org_id from the project so the session row stays consistent
  const project = db
    .prepare(`SELECT org_id FROM projects WHERE id = ?`)
    .get(projectId) as { org_id: string } | undefined;
  db.prepare(`
    INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash)
    VALUES (?, ?, ?, ?, 'running', 'Test goal', 'hash123')
  `).run(id, projectId, project?.org_id ?? null, accountId);
}

describe("TokenTracker", () => {
  let db: Database.Database;
  let tracker: TokenTracker;
  let orgId: string;
  let accountId: string;
  let projectId: string;

  beforeEach(() => {
    db = createTestDb();
    const seed = seedTestData(db);
    orgId = seed.orgId;
    accountId = seed.accountId;
    projectId = seed.projectId;
    tracker = new TokenTracker(db);
  });

  describe("recordUsage", () => {
    it("inserts a row and returns the usage record", () => {
      createSession(db, "sess_001", projectId, accountId);

      const usage = tracker.recordUsage({
        sessionId: "sess_001",
        accountId,
        projectId,
        inputTokens: 1000,
        outputTokens: 500,
        model: "claude-sonnet-4-20250514",
      });

      expect(usage.id).toBeGreaterThan(0);
      expect(usage.sessionId).toBe("sess_001");
      expect(usage.inputTokens).toBe(1000);
      expect(usage.outputTokens).toBe(500);
      expect(usage.model).toBe("claude-sonnet-4-20250514");
    });

    it("allows multiple records for the same session", () => {
      createSession(db, "sess_001", projectId, accountId);

      tracker.recordUsage({ sessionId: "sess_001", accountId, projectId, inputTokens: 100, outputTokens: 50, model: "haiku" });
      tracker.recordUsage({ sessionId: "sess_001", accountId, projectId, inputTokens: 200, outputTokens: 100, model: "haiku" });

      const rows = db.prepare("SELECT COUNT(*) as cnt FROM token_usage WHERE session_id = ?").get("sess_001") as { cnt: number };
      expect(rows.cnt).toBe(2);
    });
  });

  describe("getDailyUsage", () => {
    it("sums tokens for the correct date", () => {
      createSession(db, "sess_001", projectId, accountId);

      // Insert with explicit date
      db.prepare(`
        INSERT INTO token_usage (session_id, account_id, project_id, input_tokens, output_tokens, model, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run("sess_001", accountId, projectId, 1000, 500, "sonnet", "2026-03-28 10:00:00");

      db.prepare(`
        INSERT INTO token_usage (session_id, account_id, project_id, input_tokens, output_tokens, model, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run("sess_001", accountId, projectId, 2000, 1000, "sonnet", "2026-03-28 14:00:00");

      // Different date - should not be included
      db.prepare(`
        INSERT INTO token_usage (session_id, account_id, project_id, input_tokens, output_tokens, model, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run("sess_001", accountId, projectId, 9999, 9999, "sonnet", "2026-03-27 10:00:00");

      const usage = tracker.getDailyUsage(accountId, "2026-03-28");
      expect(usage.inputTokens).toBe(3000);
      expect(usage.outputTokens).toBe(1500);
      expect(usage.totalTokens).toBe(4500);
    });

    it("returns zero when no usage recorded", () => {
      const usage = tracker.getDailyUsage(accountId, "2026-01-01");
      expect(usage.inputTokens).toBe(0);
      expect(usage.outputTokens).toBe(0);
      expect(usage.totalTokens).toBe(0);
    });
  });

  describe("getSessionUsage", () => {
    it("sums only tokens for the specified session", () => {
      createSession(db, "sess_001", projectId, accountId);
      createSession(db, "sess_002", projectId, accountId);

      tracker.recordUsage({ sessionId: "sess_001", accountId, projectId, inputTokens: 500, outputTokens: 200, model: "haiku" });
      tracker.recordUsage({ sessionId: "sess_001", accountId, projectId, inputTokens: 300, outputTokens: 100, model: "haiku" });
      tracker.recordUsage({ sessionId: "sess_002", accountId, projectId, inputTokens: 9999, outputTokens: 9999, model: "haiku" });

      const usage = tracker.getSessionUsage("sess_001");
      expect(usage.inputTokens).toBe(800);
      expect(usage.outputTokens).toBe(300);
      expect(usage.totalTokens).toBe(1100);
    });

    it("returns zero for a session with no usage", () => {
      const usage = tracker.getSessionUsage("sess_nonexistent");
      expect(usage.totalTokens).toBe(0);
    });
  });

  describe("getProjectUsage", () => {
    it("sums all tokens for the project across sessions", () => {
      createSession(db, "sess_001", projectId, accountId);
      createSession(db, "sess_002", projectId, accountId);

      tracker.recordUsage({ sessionId: "sess_001", accountId, projectId, inputTokens: 100, outputTokens: 50, model: "haiku" });
      tracker.recordUsage({ sessionId: "sess_002", accountId, projectId, inputTokens: 200, outputTokens: 100, model: "haiku" });

      const usage = tracker.getProjectUsage(projectId);
      expect(usage.inputTokens).toBe(300);
      expect(usage.outputTokens).toBe(150);
      expect(usage.totalTokens).toBe(450);
    });
  });
});
