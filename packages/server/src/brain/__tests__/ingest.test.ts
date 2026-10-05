/**
 * Phase 0 smoke tests for the brain ingest pipeline.
 * Uses a throw-away org_id with per-test data directory isolation.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ingest, IngestSizeError } from "../ingest/pipeline.js";
import { InvalidKindError } from "../ingest/kind-validator.js";
import { activeDbFor, closeAllBrainDbs } from "../storage/active-db.js";
import type { IngestRequestT } from "../ingest/types.js";

// Isolate to a temp data dir per test run
const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-brain-test-"));
process.env.NOSLEEP_DATA_DIR = tmpDataDir;

const TEST_ORG = "org_phase0_test";
const TEST_PROJECT = "proj_smoke";

function makeRequest(overrides: Partial<IngestRequestT> = {}): IngestRequestT {
  return {
    kind: "conversation/turn/user_message",
    content: "what is going on here?",
    content_type: "text/plain",
    org_id: TEST_ORG,
    project_id: TEST_PROJECT,
    session_id: "sess_smoke_1",
    turn_ord: 1,
    origin: { tool: "claude-code", version: "2.1.72", actor: "user" },
    schema_version: 1,
    ...overrides,
  };
}

beforeAll(() => {
  // Warm-up to create schema
  activeDbFor(TEST_ORG);
});

afterAll(() => {
  closeAllBrainDbs();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("brain phase 0 ingest", () => {
  test("ingests a user message and returns a hash", () => {
    const result = ingest(makeRequest());
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.duplicate).toBe(false);
    expect(result.size).toBeGreaterThan(0);
  });

  test("dedup by content hash", () => {
    const r1 = ingest(makeRequest({ content: "identical content" }));
    const r2 = ingest(makeRequest({ content: "identical content" }));
    expect(r1.hash).toBe(r2.hash);
    expect(r2.duplicate).toBe(true);
  });

  test("rejects unknown top-level taxonomy branch", () => {
    expect(() =>
      ingest(makeRequest({ kind: "zzzunknown/foo" })),
    ).toThrow(InvalidKindError);
  });

  test("accepts unknown leaf under known branch (queues for review)", () => {
    const result = ingest(
      makeRequest({ kind: "conversation/totally_new_leaf", content: "a" }),
    );
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("enforces size cap", () => {
    const big = "x".repeat(12 * 1024 * 1024); // 12 MB
    expect(() => ingest(makeRequest({ content: big }))).toThrow(
      IngestSizeError,
    );
  });

  test("appends edges idempotently", () => {
    const a = ingest(makeRequest({ content: "first-edge-src" }));
    const b = ingest(makeRequest({ content: "first-edge-dst" }));
    ingest(
      makeRequest({
        content: "first-edge-src",
        edges: [{ to_hash: b.hash, relation: "turn_follows_turn" }],
      }),
    );
    // Re-ingest with same edge (should be a no-op on the edge row)
    ingest(
      makeRequest({
        content: "first-edge-src",
        edges: [{ to_hash: b.hash, relation: "turn_follows_turn" }],
      }),
    );

    const db = activeDbFor(TEST_ORG);
    const row = db
      .prepare(
        "SELECT COUNT(*) AS c FROM artifact_edges WHERE from_hash = ? AND to_hash = ? AND relation = ?",
      )
      .get(a.hash, b.hash, "turn_follows_turn") as { c: number };
    expect(row.c).toBe(1);
  });

  test("writes ingest_events for every call including duplicates", () => {
    const db = activeDbFor(TEST_ORG);
    const before = (
      db.prepare("SELECT COUNT(*) AS c FROM ingest_events").get() as {
        c: number;
      }
    ).c;
    ingest(makeRequest({ content: "audit-trail-test" }));
    ingest(makeRequest({ content: "audit-trail-test" })); // duplicate
    const after = (
      db.prepare("SELECT COUNT(*) AS c FROM ingest_events").get() as {
        c: number;
      }
    ).c;
    expect(after - before).toBe(2);
  });

  test("trigger rejects DELETE on artifacts", () => {
    const db = activeDbFor(TEST_ORG);
    expect(() => db.prepare("DELETE FROM artifacts").run()).toThrow(
      /append-only/,
    );
  });

  test("trigger rejects UPDATE on artifacts", () => {
    const db = activeDbFor(TEST_ORG);
    expect(() =>
      db.prepare("UPDATE artifacts SET kind = 'foo' WHERE 1=1").run(),
    ).toThrow(/append-only/);
  });

  test("trigger rejects DELETE on artifact_edges", () => {
    const db = activeDbFor(TEST_ORG);
    expect(() => db.prepare("DELETE FROM artifact_edges").run()).toThrow(
      /append-only/,
    );
  });

  test("FTS row populated for text kinds", () => {
    const r = ingest(
      makeRequest({ content: "alpha beta gamma", kind: "knowledge/note" }),
    );
    const db = activeDbFor(TEST_ORG);
    const row = db
      .prepare("SELECT text FROM artifacts_fts_src WHERE hash = ?")
      .get(r.hash) as { text: string } | undefined;
    expect(row?.text).toBe("alpha beta gamma");

    const match = db
      .prepare(
        "SELECT hash FROM artifacts_fts WHERE artifacts_fts MATCH 'gamma' AND project_id = ?",
      )
      .all(TEST_PROJECT) as { hash: string }[];
    expect(match.some((m) => m.hash === r.hash)).toBe(true);
  });

  test("schema migrations are applied", () => {
    const db = activeDbFor(TEST_ORG);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const names = new Set(tables.map((t) => t.name));
    // Sample checks — presence of every phase-0 table
    for (const t of [
      "artifacts",
      "artifact_projects",
      "artifact_edges",
      "artifacts_fts_src",
      "image_features",
      "code_symbols",
      "artifact_num_meta",
      "thoughts",
      "thought_refs",
      "thought_archive_refs",
      "entities",
      "entity_refs",
      "metrics",
      "ingest_events",
      "extractor_runs",
      "hook_fires",
      "query_logs",
      "brain_session_events",
      "_brain_migrations",
    ]) {
      expect(names.has(t)).toBe(true);
    }
  });
});
