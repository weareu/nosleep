import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { PlanResolver } from "../../orchestrator/plan-resolver.js";
import { createTestDb, seedMultiOrg } from "../helpers/db.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("PlanResolver.resolve", () => {
  let db: Database.Database;
  let resolver: PlanResolver;
  let projectId: string;
  let orgId: string;
  let tmpRoot: string;

  beforeEach(() => {
    db = createTestDb();
    const ids = seedMultiOrg(db);
    projectId = ids.personal.projectId;
    orgId = ids.personal.orgId;
    resolver = new PlanResolver(db);
    tmpRoot = mkdtempSync(join(tmpdir(), "plan-resolver-test-"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns goal unchanged when no strategyNodeId given", async () => {
    const result = await resolver.resolve("do the thing", undefined, tmpRoot);
    expect(result.goal).toBe("do the thing");
    expect(result.planContext).toBeNull();
  });

  it("returns goal unchanged when node doesn't exist", async () => {
    const result = await resolver.resolve("do the thing", "nope", tmpRoot);
    expect(result.goal).toBe("do the thing");
    expect(result.planContext).toBeNull();
  });

  it("reads plan content when source_ref is set", async () => {
    const plansDir = join(tmpRoot, "docs", "plans");
    mkdirSync(plansDir, { recursive: true });
    const planPath = join(plansDir, "test.md");
    writeFileSync(planPath, "# My Plan\nSteps: 1, 2, 3");

    db.prepare(`
      INSERT INTO strategy_nodes (id, project_id, org_id, type, title, source_ref)
      VALUES ('n1', ?, ?, 'task', 'Test Task', ?)
    `).run(projectId, orgId, planPath);

    const result = await resolver.resolve("g", "n1", tmpRoot);
    expect(result.planContext).toContain("My Plan");
    expect(result.planContext).toContain("Steps: 1, 2, 3");
  });

  it("strips line ref (e.g. :L42) from source_ref before reading", async () => {
    const plansDir = join(tmpRoot, "docs", "plans");
    mkdirSync(plansDir, { recursive: true });
    const planPath = join(plansDir, "p.md");
    writeFileSync(planPath, "real content");

    db.prepare(`
      INSERT INTO strategy_nodes (id, project_id, org_id, type, title, source_ref)
      VALUES ('n1', ?, ?, 'task', 'T', ?)
    `).run(projectId, orgId, `${planPath}:L42-L88`);

    const result = await resolver.resolve("g", "n1", tmpRoot);
    expect(result.planContext).toContain("real content");
  });

  it("falls through to PLAN-FIRST instructions when no plan exists anywhere", async () => {
    db.prepare(`
      INSERT INTO strategy_nodes (id, project_id, org_id, type, title)
      VALUES ('n1', ?, ?, 'task', 'Add Login')
    `).run(projectId, orgId);

    const result = await resolver.resolve("original task", "n1", tmpRoot);
    expect(result.goal).toContain("PLAN THEN EXECUTE");
    expect(result.goal).toContain("docs/plans/add-login.md");
    expect(result.goal).toContain("original task");
    expect(result.planContext).toBeNull();
  });

  it("matches a plan by exact title in content (keyword fallback)", async () => {
    db.prepare(`UPDATE projects SET path = ? WHERE id = ?`).run(tmpRoot, projectId);
    const plansDir = join(tmpRoot, "docs", "plans");
    mkdirSync(plansDir, { recursive: true });
    writeFileSync(join(plansDir, "auth.md"), "# Refactor Authentication\nDetails here");

    db.prepare(`
      INSERT INTO strategy_nodes (id, project_id, org_id, type, title)
      VALUES ('n1', ?, ?, 'task', 'Refactor Authentication')
    `).run(projectId, orgId);

    const result = await resolver.resolve("g", "n1", tmpRoot);
    expect(result.planContext).toContain("Details here");

    // Also: source_ref should now be set on the node
    const node = db.prepare(`SELECT source_ref FROM strategy_nodes WHERE id = 'n1'`).get() as { source_ref: string };
    expect(node.source_ref).toBeTruthy();
  });

  it("matches a plan when ≥70% of title words appear in content", async () => {
    db.prepare(`UPDATE projects SET path = ? WHERE id = ?`).run(tmpRoot, projectId);
    const dir = join(tmpRoot, "docs", "architecture");
    mkdirSync(dir, { recursive: true });
    // Title: "Add Embedding Drift Detection" — 4 words ≥3 chars: add, embedding, drift, detection
    // Content has 3/4 — should match (75%)
    writeFileSync(join(dir, "drift.md"), "We add drift detection to the system");

    db.prepare(`
      INSERT INTO strategy_nodes (id, project_id, org_id, type, title)
      VALUES ('n1', ?, ?, 'task', 'Add Embedding Drift Detection')
    `).run(projectId, orgId);

    const result = await resolver.resolve("g", "n1", tmpRoot);
    expect(result.planContext).toContain("drift detection");
  });

  it("truncates very large plans to ~4000 chars + ellipsis marker", async () => {
    const plansDir = join(tmpRoot, "docs", "plans");
    mkdirSync(plansDir, { recursive: true });
    const huge = "x".repeat(10_000);
    writeFileSync(join(plansDir, "p.md"), huge);

    db.prepare(`
      INSERT INTO strategy_nodes (id, project_id, org_id, type, title, source_ref)
      VALUES ('n1', ?, ?, 'task', 'T', ?)
    `).run(projectId, orgId, join(plansDir, "p.md"));

    const result = await resolver.resolve("g", "n1", tmpRoot);
    expect(result.planContext).toContain("[...plan truncated");
    expect(result.planContext!.length).toBeLessThan(5000);
  });
});
