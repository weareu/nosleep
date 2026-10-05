/**
 * Phase 9 fan-out tests — verify that BM25 + semantic span sealed files
 * when QuerySpec.time_range === "all_time".
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-brain-fanout-"));
process.env.NOSLEEP_DATA_DIR = tmpDataDir;

import { ingest } from "../ingest/pipeline.js";
import { search } from "../retrieval/search.js";
import { sealActiveDb } from "../seal/seal-job.js";
import { activeDbFor, closeAllBrainDbs } from "../storage/active-db.js";
import { selectFiles } from "../storage/file-selection.js";
import { QuerySpec } from "../retrieval/query-spec.js";
import { catalogDbFor } from "../storage/catalog-db.js";

const ORG = "org_fanout_test";
const PROJ = "proj_fanout";

beforeAll(() => {
  activeDbFor(ORG);
});

afterAll(() => {
  closeAllBrainDbs();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("phase 9 — multi-file fan-out", () => {
  test("seals one quarter, then BM25 fan-out finds the sealed-only artifact", async () => {
    const sealedHash = ingest({
      kind: "knowledge/note",
      content: "alpha bravo charlie delta echo — only in the sealed quarter",
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "test" },
      schema_version: 1,
    }).hash;

    const sealResult = await sealActiveDb({
      org_id: ORG,
      quarter: "2099-Q9",
      skip_hnsw: true,
    });
    expect(sealResult.artifact_count).toBeGreaterThanOrEqual(1);

    // Simulate "active.db rotated" by removing the row from active. Phase 8
    // v1 ships seal-as-snapshot; physical rotation lands later, so for the
    // fan-out test we drop the append-only trigger temporarily and delete
    // directly. This proves the row is reachable ONLY through the sealed
    // file.
    const active = activeDbFor(ORG);
    active.prepare("DROP TRIGGER IF EXISTS trg_no_delete_artifacts").run();
    active.prepare("DROP TRIGGER IF EXISTS trg_no_delete_fts_src").run();
    active.prepare("DELETE FROM artifacts WHERE hash = ?").run(sealedHash);
    active.prepare("DELETE FROM artifacts_fts_src WHERE hash = ?").run(sealedHash);

    // Default time_range="recent" should NOT find the sealed-only artifact.
    const recent = await search(
      QuerySpec.parse({
        org_id: ORG,
        project_id: PROJ,
        text: { query: "alpha bravo charlie", mode: "lexical" },
      }),
    );
    expect(recent.results.find((r) => r.hash === sealedHash)).toBeUndefined();
    expect(recent.files_queried).toBeUndefined();

    // time_range="all_time" must fan out to the sealed file and surface the
    // row.
    const allTime = await search(
      QuerySpec.parse({
        org_id: ORG,
        project_id: PROJ,
        text: { query: "alpha bravo charlie", mode: "lexical" },
        time_range: "all_time",
      }),
    );
    expect(allTime.files_queried).toBeDefined();
    expect(allTime.files_queried!.length).toBeGreaterThan(1);
    expect(
      allTime.files_queried!.some((n) => n.startsWith("sealed-")),
    ).toBe(true);
    const hit = allTime.results.find((r) => r.hash === sealedHash);
    expect(hit).toBeDefined();
    expect(hit!.snippet.toLowerCase()).toContain("alpha bravo");
  });

  test("file selection respects ts range filter", () => {
    const cat = catalogDbFor(ORG);
    const rows = cat
      .prepare("SELECT file_name FROM sealed_files WHERE org_id = ?")
      .all(ORG);
    expect(rows.length).toBeGreaterThan(0);

    // Far-future window — no sealed file should overlap.
    const future = selectFiles({
      org_id: ORG,
      include_sealed: true,
      ts_from: 4_000_000_000,
      ts_to: 4_100_000_000,
    });
    expect(future.filter((f) => f.kind === "sealed").length).toBe(0);
  });

  test("fan-out without sealed files falls back to active", async () => {
    const ORG_FRESH = "org_fanout_fresh";
    activeDbFor(ORG_FRESH);

    ingest({
      kind: "knowledge/note",
      content: "papa quebec romeo — fresh active artifact",
      content_type: "text/plain",
      org_id: ORG_FRESH,
      project_id: PROJ,
      origin: { tool: "test" },
      schema_version: 1,
    });

    const r = await search(
      QuerySpec.parse({
        org_id: ORG_FRESH,
        project_id: PROJ,
        text: { query: "papa quebec", mode: "lexical" },
        time_range: "all_time",
      }),
    );
    expect(r.results.length).toBeGreaterThan(0);
    // No sealed files → no fan-out → files_queried omitted
    expect(r.files_queried).toBeUndefined();
  });
});
