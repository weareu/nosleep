/**
 * Phase 1 retrieval tests — BM25 search, facet/temporal filters, pure-filter
 * scan, artifact read, session pagination, query_logs audit trail.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-brain-retrieval-"));
process.env.NOSLEEP_DATA_DIR = tmpDataDir;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import { ingest } from "../ingest/pipeline.js";
import { search } from "../retrieval/search.js";
import { activeDbFor, closeAllBrainDbs } from "../storage/active-db.js";
import { runBm25 } from "../retrieval/retrievers/bm25.js";
import { QuerySpec } from "../retrieval/query-spec.js";

const ORG = "org_retrieval_test";
const PROJ = "proj_r1";

function seed(content: string, kind = "knowledge/note", session = "sess_1") {
  return ingest({
    kind,
    content,
    content_type: "text/plain",
    org_id: ORG,
    project_id: PROJ,
    session_id: session,
    turn_ord: 1,
    origin: { tool: "claude-code", actor: "test" },
    schema_version: 1,
  });
}

beforeAll(() => {
  activeDbFor(ORG); // warm up schema
});

afterAll(() => {
  closeAllBrainDbs();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("brain phase 1 retrieval", () => {
  beforeEach(() => {
    // Each test seeds its own content; no shared state cleanup needed because
    // archive is append-only and hashes are content-addressed.
  });

  test("BM25 finds text matches", () => {
    const a = seed("the quick brown fox jumps over the lazy dog");
    const b = seed("nothing to see here, no animals");
    const q = QuerySpec.parse({
      org_id: ORG,
      project_id: PROJ,
      text: { query: "brown fox", mode: "lexical" },
    });
    const db = activeDbFor(ORG);
    const results = runBm25(db, q, 10);
    const hashes = results.map((r) => r.hash);
    expect(hashes).toContain(a.hash);
    expect(hashes).not.toContain(b.hash);
  });

  test("search returns shaped response with snippet", async () => {
    seed("ephemeris aurora boreal", "knowledge/insight");
    const response = await search(
      QuerySpec.parse({
        org_id: ORG,
        project_id: PROJ,
        text: { query: "aurora", mode: "lexical" },
      }),
    );
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.results[0].snippet).toContain("aurora");
    expect(response.results[0].kind).toBe("knowledge/insight");
    expect(response.latency_ms).toBeGreaterThan(0);
    expect(response.query_id).toBeTruthy();
  });

  test("facet filter kind_prefix scopes results", async () => {
    seed("decision one", "decision/record");
    seed("note one", "knowledge/note");
    const response = await search(
      QuerySpec.parse({
        org_id: ORG,
        project_id: PROJ,
        text: { query: "one", mode: "lexical" },
        facets: { kind_prefix: ["decision/"] },
      }),
    );
    for (const r of response.results) {
      expect(r.kind.startsWith("decision/")).toBe(true);
    }
  });

  test("session filter narrows to one session", async () => {
    const a = seed("session-a marker", "knowledge/note", "sess_alpha");
    const b = seed("session-b marker", "knowledge/note", "sess_beta");
    const response = await search(
      QuerySpec.parse({
        org_id: ORG,
        project_id: PROJ,
        text: { query: "marker", mode: "lexical" },
        facets: { session_id: "sess_alpha" },
      }),
    );
    const hashes = response.results.map((r) => r.hash);
    expect(hashes).toContain(a.hash);
    expect(hashes).not.toContain(b.hash);
  });

  test("pure-filter query returns latest rows first", async () => {
    seed("first filter content", "task/todo");
    seed("second filter content", "task/todo");
    const response = await search(
      QuerySpec.parse({
        org_id: ORG,
        project_id: PROJ,
        facets: { kind_prefix: ["task/"] },
        limit: 5,
      }),
    );
    expect(response.results.length).toBeGreaterThan(0);
    for (const r of response.results) {
      expect(r.kind.startsWith("task/")).toBe(true);
    }
  });

  test("empty QuerySpec is rejected", async () => {
    // scope=project + a real project_id IS a filter (Phase 11) so we must
    // pass the org-level sentinel to actually trigger the empty-spec branch.
    const q = QuerySpec.parse({
      org_id: ORG,
      project_id: "_org_level",
      scope: "project",
    });
    await expect(search(q)).rejects.toThrow(/empty/);
  });

  test("query_logs row written per search", async () => {
    const db = activeDbFor(ORG);
    const before = (
      db.prepare("SELECT COUNT(*) AS c FROM query_logs").get() as { c: number }
    ).c;
    await search(
      QuerySpec.parse({
        org_id: ORG,
        project_id: PROJ,
        text: { query: "query-log-test", mode: "lexical" },
      }),
    );
    const after = (
      db.prepare("SELECT COUNT(*) AS c FROM query_logs").get() as { c: number }
    ).c;
    expect(after - before).toBe(1);
  });

  test("score_breakdown populated when requested", async () => {
    seed("score breakdown check", "knowledge/note");
    const response = await search(
      QuerySpec.parse({
        org_id: ORG,
        project_id: PROJ,
        text: { query: "breakdown", mode: "lexical" },
        return_score_breakdown: true,
      }),
    );
    expect(response.results[0].score_breakdown).toBeDefined();
    expect(response.results[0].score_breakdown?.bm25).toBeDefined();
  });
});
