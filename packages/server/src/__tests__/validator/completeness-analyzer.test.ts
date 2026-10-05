import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { createTestDb, seedTestData } from "../helpers/db.js";

// Control the AI verdict without spawning claude.
const validateWithAi = vi.fn();
vi.mock("../../validator/ai-validator.js", () => ({
  validateWithAi: (...args: unknown[]) => validateWithAi(...args),
}));

import { CompletenessAnalyzer } from "../../validator/completeness-analyzer.js";
import { GoalManager } from "../../focus/goal-manager.js";

describe("CompletenessAnalyzer.analyzeCompleteness", () => {
  let db: Database.Database;
  let analyzer: CompletenessAnalyzer;
  let goals: GoalManager;
  let dir: string;
  let ids: { orgId: string; projectId: string; accountId: string };

  beforeEach(() => {
    db = createTestDb();
    ids = seedTestData(db);
    db.prepare(
      `INSERT INTO sessions (id, project_id, org_id, account_id, status, goal_text, goal_hash, started_at, last_activity_at)
       VALUES ('sess_a', ?, ?, ?, 'running', 'g', 'h', datetime('now'), datetime('now'))`,
    ).run(ids.projectId, ids.orgId, ids.accountId);
    goals = new GoalManager(db);
    analyzer = new CompletenessAnalyzer(db, goals);
    dir = mkdtempSync(join(tmpdir(), "nosleep-comp-"));
    validateWithAi.mockReset();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    db.close();
  });

  function makeGoal(): string {
    return goals.createGoal({
      sessionId: "sess_a",
      projectId: ids.projectId,
      objective: "Implement feature X",
      acceptanceCriteria: ["Feature X works"],
    }).id;
  }

  it("verdict is 'stub' when a modified file contains a stub — even if AI says complete", async () => {
    validateWithAi.mockResolvedValue({
      verdict: "complete",
      criteriaResults: [{ criterion: "Feature X works", status: "met", notes: "ok" }],
      overallNotes: "looks done",
    });
    const file = join(dir, "impl.ts");
    writeFileSync(file, "export function x() {\n  // TODO implement\n}");

    const goalId = makeGoal();
    const result = await analyzer.analyzeCompleteness(goalId, {
      modifiedFiles: [file],
      additions: 3,
      deletions: 0,
      diffSummary: "added impl.ts",
    }, dir);

    expect(result?.verdict).toBe("stub"); // stub overrides AI's "complete"
  });

  it("verdict is 'complete' when no stubs and all criteria met", async () => {
    validateWithAi.mockResolvedValue({
      verdict: "complete",
      criteriaResults: [{ criterion: "Feature X works", status: "met", notes: "ok" }],
      overallNotes: "done",
    });
    const file = join(dir, "impl.ts");
    writeFileSync(file, "export function x() { return 42; }");

    const goalId = makeGoal();
    const result = await analyzer.analyzeCompleteness(goalId, {
      modifiedFiles: [file],
      additions: 1,
      deletions: 0,
      diffSummary: "added impl.ts",
    }, dir);

    expect(result?.verdict).toBe("complete");
  });

  it("does NOT pass by default when the AI call fails — falls back to heuristic 'incomplete'", async () => {
    validateWithAi.mockRejectedValue(new Error("claude unavailable"));
    const file = join(dir, "unrelated.md");
    writeFileSync(file, "just docs");

    const goalId = makeGoal();
    const result = await analyzer.analyzeCompleteness(goalId, {
      modifiedFiles: [file],
      additions: 1,
      deletions: 0,
      diffSummary: "added docs",
    }, dir);

    expect(result?.verdict).toBe("incomplete"); // unmet criterion → not silently "complete"
  });
});
