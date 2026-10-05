import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, seedTestData } from "../helpers/db.js";

// Isolate the brain data dir BEFORE importing anything that touches it.
const dataDir = mkdtempSync(join(tmpdir(), "nosleep-recall-"));
process.env.NOSLEEP_DATA_DIR = dataDir;

const { buildRecallBlock, extractKeywords } = await import("../../orchestrator/memory-recall.js");
const { captureThought } = await import("../../brain/thoughts/capture.js");

describe("extractKeywords", () => {
  it("pulls significant distinct words, skipping stopwords and short tokens", () => {
    const kws = extractKeywords("Continue the autonomous loop: fix the watchdog restart cascade in the scheduler");
    expect(kws).toContain("watchdog");
    expect(kws).toContain("restart");
    expect(kws).not.toContain("the");
    expect(kws).not.toContain("loop"); // stopword (loop-prompt boilerplate)
    expect(kws.length).toBeLessThanOrEqual(6);
  });
});

describe("buildRecallBlock", () => {
  let db: Database.Database;
  let ids: { orgId: string; projectId: string };

  beforeEach(() => {
    db = createTestDb();
    ids = seedTestData(db);
  });
  afterEach(() => db.close());

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("returns null when there is nothing to recall", () => {
    const block = buildRecallBlock({ mainDb: db, orgId: ids.orgId, projectId: ids.projectId, goalText: "zzqx nonexistent gibberish" });
    expect(block).toBeNull();
  });

  it("includes org memory rows and bumps access_count on injection", () => {
    db.prepare(
      `INSERT INTO memory (id, org_id, project_id, category, key, value) VALUES ('m1', ?, NULL, 'pattern', 'watchdog-restarts', 'Always check the watchdog before restarting')`,
    ).run(ids.orgId);

    const block = buildRecallBlock({ mainDb: db, orgId: ids.orgId, projectId: ids.projectId, goalText: "anything at all here" });
    expect(block).toContain("## Relevant memory");
    expect(block).toContain("watchdog-restarts");

    const row = db.prepare(`SELECT access_count FROM memory WHERE id='m1'`).get() as { access_count: number };
    expect(row.access_count).toBe(1); // recall finally moves the needle
  });

  it("includes brain thoughts matching goal keywords", () => {
    captureThought({
      org_id: ids.orgId,
      project_id: ids.projectId,
      content: "The vector indexer must always yield to the event loop during walkDir",
      source_kind: "mcp_capture",
    });

    const block = buildRecallBlock({ mainDb: db, orgId: ids.orgId, projectId: ids.projectId, goalText: "Improve the vector indexer performance" });
    expect(block).toContain("## Relevant memory");
    expect(block).toContain("walkDir");
    expect(block).toMatch(/thought:/);
  });
});
