/**
 * Phase 3 semantic tests. Installs a deterministic fake embed provider so
 * we exercise the vec pipeline without requiring the ONNX model.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-brain-semantic-"));
process.env.NOSLEEP_DATA_DIR = tmpDataDir;

import { ingest } from "../ingest/pipeline.js";
import { search } from "../retrieval/search.js";
import { runSemanticText } from "../retrieval/retrievers/semantic-text.js";
import { QuerySpec } from "../retrieval/query-spec.js";
import { rrf } from "../retrieval/rrf.js";
import {
  setEmbedProvider,
  EMBED_DIM,
  type EmbedProvider,
} from "../extractors/embed-provider.js";
import {
  scheduleTextEmbedding,
  waitForExtractorQueue,
} from "../extractors/worker.js";
import { activeDbFor, closeAllBrainDbs } from "../storage/active-db.js";
import { isVecLoaded } from "../storage/vec-loader.js";
import { setRerankProvider, type RerankProvider } from "../retrieval/rerank.js";

const ORG = "org_semantic_test";
const PROJ = "proj_s1";

/**
 * Deterministic fake embedder: hashes the text into 384 floats, L2-normalised.
 * Same text always produces the same vector, and similar texts produce
 * clusters because the hash-fold preserves prefix similarity.
 */
class FakeEmbedProvider implements EmbedProvider {
  readonly name = "fake-test";
  readonly dim = EMBED_DIM;
  async embed(text: string): Promise<Float32Array> {
    const out = new Float32Array(EMBED_DIM);
    const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
    for (const tok of tokens) {
      const h = createHash("sha256").update(tok).digest();
      // Spread 32 bytes across EMBED_DIM; each byte contributes to a few cells
      for (let i = 0; i < h.length; i++) {
        const idx = (i * 13) % EMBED_DIM;
        out[idx] += (h[i] - 128) / 128;
      }
    }
    // L2 normalise
    let norm = 0;
    for (let i = 0; i < EMBED_DIM; i++) norm += out[i] * out[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < EMBED_DIM; i++) out[i] /= norm;
    }
    return out;
  }
}

beforeAll(() => {
  setEmbedProvider(new FakeEmbedProvider());
  activeDbFor(ORG);
});

afterAll(() => {
  setEmbedProvider(null);
  setRerankProvider(null);
  closeAllBrainDbs();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

beforeEach(() => {
  setRerankProvider(null);
});

describe("brain phase 3 semantic", () => {
  test("vec extension loads in brain active.db", () => {
    expect(isVecLoaded(activeDbFor(ORG))).toBe(true);
  });

  test("ingest enqueues embedding; vec_text_map row written after drain", async () => {
    const r = ingest({
      kind: "knowledge/insight",
      content: "Vector lookup for auth rotation plan",
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "claude-code", actor: "test" },
      schema_version: 1,
    });

    await waitForExtractorQueue();

    const db = activeDbFor(ORG);
    const row = db
      .prepare(
        "SELECT COUNT(*) AS c FROM vec_text_map WHERE hash = ? AND referrer_kind = 'artifact'",
      )
      .get(r.hash) as { c: number };
    expect(row.c).toBeGreaterThan(0);
  });

  test("semantic retriever returns the closest match", async () => {
    ingest({
      kind: "knowledge/insight",
      content: "Quick brown fox jumps over the lazy dog",
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "claude-code" },
      schema_version: 1,
    });
    const b = ingest({
      kind: "knowledge/insight",
      content: "Quantum entanglement in photon pairs",
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "claude-code" },
      schema_version: 1,
    });

    // Also embed direct via scheduleTextEmbedding to exercise the explicit path
    await scheduleTextEmbedding({
      referrer_kind: "artifact",
      hash: b.hash,
      text: "Quantum entanglement in photon pairs",
      project_id: PROJ,
      org_id: ORG,
    });
    await waitForExtractorQueue();

    const q = QuerySpec.parse({
      org_id: ORG,
      project_id: PROJ,
      text: { query: "quantum entanglement photon", mode: "semantic" },
    });
    const db = activeDbFor(ORG);
    const results = await runSemanticText(db, q, 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].hash).toBe(b.hash);
  });

  test("hybrid mode fuses BM25 + semantic via RRF", async () => {
    ingest({
      kind: "knowledge/insight",
      content: "hybrid-search-test foo bar baz",
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "claude-code" },
      schema_version: 1,
    });
    await waitForExtractorQueue();

    const response = await search(
      QuerySpec.parse({
        org_id: ORG,
        project_id: PROJ,
        text: { query: "hybrid-search-test", mode: "hybrid" },
        return_score_breakdown: true,
      }),
    );
    expect(response.results.length).toBeGreaterThan(0);
    const breakdown = response.results[0].score_breakdown;
    expect(breakdown).toBeDefined();
    // At least BM25 or semantic should have fired.
    const retrievers = Object.keys(breakdown ?? {});
    expect(retrievers.some((k) => k === "bm25" || k === "semantic_text")).toBe(true);
  });

  test("RRF fuses multiple ranked lists correctly", () => {
    const fused = rrf(
      [
        {
          retriever: "a",
          weight: 1,
          results: [
            { hash: "x", rank: 1, raw_score: 0.9, retriever: "a" },
            { hash: "y", rank: 2, raw_score: 0.5, retriever: "a" },
          ],
        },
        {
          retriever: "b",
          weight: 1,
          results: [
            { hash: "y", rank: 1, raw_score: 0.7, retriever: "b" },
            { hash: "z", rank: 2, raw_score: 0.3, retriever: "b" },
          ],
        },
      ],
      60,
    );
    const byHash = new Map(fused.map((f) => [f.hash, f.fused_score]));
    // y appears in both, ranks 2+1 → higher fused score than x (rank 1 only)
    expect((byHash.get("y") ?? 0) > (byHash.get("x") ?? 0)).toBe(true);
  });

  test("cross-encoder rerank reorders via provider", async () => {
    ingest({
      kind: "knowledge/note",
      content: "rerank-test apple",
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "test" },
      schema_version: 1,
    });
    ingest({
      kind: "knowledge/note",
      content: "rerank-test banana",
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "test" },
      schema_version: 1,
    });

    // Install a provider that always favours 'banana'
    const fakeReranker: RerankProvider = {
      name: "fake-prefer-banana",
      async rerank(_query, candidates) {
        const sorted = [...candidates].sort((a, b) => {
          const ab = a.text.includes("banana") ? 0 : 1;
          const bb = b.text.includes("banana") ? 0 : 1;
          return ab - bb;
        });
        return sorted.map((c, i) => ({ hash: c.hash, rank: i + 1, score: 1 - i / 10 }));
      },
    };
    setRerankProvider(fakeReranker);

    const response = await search(
      QuerySpec.parse({
        org_id: ORG,
        project_id: PROJ,
        text: { query: "rerank-test", mode: "lexical" },
      }),
    );
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.results[0].snippet).toContain("banana");
  });

  test("semantic retrieval returns empty when provider throws", async () => {
    const throwingProvider: EmbedProvider = {
      name: "throws",
      dim: EMBED_DIM,
      async embed() {
        throw new Error("boom");
      },
    };
    setEmbedProvider(throwingProvider);
    const db = activeDbFor(ORG);
    const q = QuerySpec.parse({
      org_id: ORG,
      project_id: PROJ,
      text: { query: "anything", mode: "semantic" },
    });
    const results = await runSemanticText(db, q, 10);
    expect(results).toEqual([]);
    setEmbedProvider(new FakeEmbedProvider());
  });

  test("duplicate embed call is idempotent", async () => {
    const r = ingest({
      kind: "knowledge/insight",
      content: "idempotent embed test content",
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "test" },
      schema_version: 1,
    });
    await waitForExtractorQueue();
    const db = activeDbFor(ORG);
    const before = (
      db
        .prepare("SELECT COUNT(*) AS c FROM vec_text_map WHERE hash = ?")
        .get(r.hash) as { c: number }
    ).c;
    await scheduleTextEmbedding({
      referrer_kind: "artifact",
      hash: r.hash,
      text: "idempotent embed test content",
      project_id: PROJ,
      org_id: ORG,
    });
    await waitForExtractorQueue();
    const after = (
      db
        .prepare("SELECT COUNT(*) AS c FROM vec_text_map WHERE hash = ?")
        .get(r.hash) as { c: number }
    ).c;
    expect(after).toBe(before); // no new rows on repeat
  });
});
