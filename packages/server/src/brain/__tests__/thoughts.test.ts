/**
 * Phase 2 thoughts tests. Mocks the LLM extractor so tests run without
 * invoking the real `claude` CLI.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-brain-thoughts-"));
process.env.NOSLEEP_DATA_DIR = tmpDataDir;

import { captureThought } from "../thoughts/capture.js";
import { getThought } from "../thoughts/get.js";
import { listThoughts } from "../thoughts/list.js";
import { searchThoughts } from "../thoughts/search.js";
import { thoughtStats } from "../thoughts/stats.js";
import { promoteArtifact } from "../thoughts/promote.js";
import { ingest } from "../ingest/pipeline.js";
import { activeDbFor, closeAllBrainDbs } from "../storage/active-db.js";

const ORG = "org_thoughts_test";
const PROJ = "proj_t1";

beforeAll(() => {
  activeDbFor(ORG);
});

afterAll(() => {
  closeAllBrainDbs();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("brain phase 2 thoughts", () => {
  test("capture writes a thought and enqueues metadata_llm", () => {
    const res = captureThought({
      content: "Decided to switch JWT signing to ES256",
      org_id: ORG,
      project_id: PROJ,
      source_kind: "mcp_capture",
      thought_type_hint: "decision",
    });
    expect(res.id).toMatch(/^thg_/);
    expect(res.enqueued_extractors).toContain("metadata_llm");
  });

  test("captured thought is immediately FTS-searchable", () => {
    captureThought({
      content: "jwt ES256 rotation plan",
      org_id: ORG,
      project_id: PROJ,
      source_kind: "mcp_capture",
    });
    const results = searchThoughts({
      orgId: ORG,
      projectId: PROJ,
      query: "ES256",
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].thought.content).toContain("ES256");
  });

  test("list filters by type", () => {
    captureThought({
      content: "task: rotate keys tomorrow",
      org_id: ORG,
      project_id: PROJ,
      source_kind: "mcp_capture",
      thought_type_hint: "task",
    });
    captureThought({
      content: "observation: deploys take 4 minutes",
      org_id: ORG,
      project_id: PROJ,
      source_kind: "mcp_capture",
      thought_type_hint: "observation",
    });
    const tasks = listThoughts({
      orgId: ORG,
      projectId: PROJ,
      type: "task",
    });
    expect(tasks.every((t) => t.thought_type === "task")).toBe(true);
  });

  test("get returns the thought with refs when requested", () => {
    const cap = captureThought({
      content: "question: why did the cache miss?",
      org_id: ORG,
      project_id: PROJ,
      source_kind: "mcp_capture",
    });
    const got = getThought(ORG, cap.id, new Set(["refs"]));
    expect(got).not.toBeNull();
    expect(got?.id).toBe(cap.id);
    expect(got?.archive_refs).toEqual([]);
    expect(got?.thought_refs?.outgoing).toEqual([]);
    expect(got?.thought_refs?.incoming).toEqual([]);
  });

  test("promote_artifact captures a thought with distilled_from ref", () => {
    // Seed an archive artifact
    const a = ingest({
      kind: "knowledge/insight",
      content: "The auth middleware regression was caused by middleware ordering.",
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "claude-code", actor: "test" },
      schema_version: 1,
    });

    const promoted = promoteArtifact({
      archive_hash: a.hash,
      org_id: ORG,
      project_id: PROJ,
      thought_type_hint: "insight",
    });

    expect(promoted.id).toMatch(/^thg_/);

    const full = getThought(ORG, promoted.id, new Set(["refs"]));
    expect(full?.source_kind).toBe("promoted_from_archive");
    expect(full?.archive_refs).toEqual([
      { archive_hash: a.hash, relation: "distilled_from" },
    ]);
  });

  test("stats aggregates counts by type", () => {
    const stats = thoughtStats(ORG, PROJ);
    expect(stats.total).toBeGreaterThan(0);
    const types = new Map(stats.types.map((t) => [t.type, t.count]));
    expect(types.get("task") ?? 0).toBeGreaterThan(0);
    expect(types.get("observation") ?? 0).toBeGreaterThan(0);
  });

  test("dedup surface returns similar thoughts", () => {
    captureThought({
      content: "flag: monitor dashboard latency during deploy window",
      org_id: ORG,
      project_id: PROJ,
      source_kind: "mcp_capture",
    });
    const second = captureThought({
      content: "flag: monitor dashboard latency during deploy window",
      org_id: ORG,
      project_id: PROJ,
      source_kind: "mcp_capture",
    });
    // Phase 2 FTS-based dedup surfaces prior matches, not blocks the capture
    expect(second.similar_existing.length).toBeGreaterThan(0);
  });

  test("thoughts trigger still blocks content update (append-only)", () => {
    const cap = captureThought({
      content: "immutable content test",
      org_id: ORG,
      project_id: PROJ,
      source_kind: "mcp_capture",
    });
    const db = activeDbFor(ORG);
    expect(() =>
      db.prepare("UPDATE thoughts SET content = 'modified' WHERE id = ?").run(cap.id),
    ).toThrow(/immutable/);
  });

  test("but metadata_json IS writeable (extractor path)", () => {
    const cap = captureThought({
      content: "metadata writable check",
      org_id: ORG,
      project_id: PROJ,
      source_kind: "mcp_capture",
    });
    const db = activeDbFor(ORG);
    // Simulate the extractor updating metadata
    db.prepare(
      `UPDATE thoughts SET metadata_json = ?, thought_type = ?, updated_at = ? WHERE id = ?`,
    ).run(
      JSON.stringify({
        type: "insight",
        topics: ["metadata"],
        people: [],
        action_items: [],
        dates_mentioned: [],
      }),
      "insight",
      Math.floor(Date.now() / 1000),
      cap.id,
    );
    const refreshed = getThought(ORG, cap.id, new Set());
    expect(refreshed?.thought_type).toBe("insight");
    expect(refreshed?.metadata.topics).toEqual(["metadata"]);
  });
});
