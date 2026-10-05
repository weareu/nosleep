/**
 * Phase 5 tests — large-blob CAS, code symbol extraction, code-structural
 * retrieval, image extractor pluggable providers, perceptual retriever.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-brain-phase5-"));
process.env.NOSLEEP_DATA_DIR = tmpDataDir;

import { ingest } from "../ingest/pipeline.js";
import { search } from "../retrieval/search.js";
import {
  runCodeSymbolExtraction,
  extractSymbols,
} from "../extractors/code-symbols.js";
import {
  runImageExtraction,
  type ImageExtractTarget,
} from "../extractors/image-extractor.js";
import {
  setImageProviders,
  resetImageProviders,
  type PhashProvider,
  type CaptionProvider,
} from "../extractors/image-providers.js";
import {
  hasCasBlob,
  readCasBlob,
  verifyCasBlob,
} from "../storage/cas-blobs.js";
import { runPerceptualImage } from "../retrieval/retrievers/perceptual-image.js";
import { QuerySpec } from "../retrieval/query-spec.js";
import { activeDbFor, closeAllBrainDbs } from "../storage/active-db.js";
import { BRAIN_LARGE_BLOB_THRESHOLD } from "../config.js";

const ORG = "org_phase5_test";
const PROJ = "proj_p5";

beforeAll(() => {
  activeDbFor(ORG);
});

afterAll(() => {
  resetImageProviders();
  closeAllBrainDbs();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("brain phase 5 — large-blob CAS", () => {
  test("small blob stays inline (compression='none')", () => {
    const r = ingest({
      kind: "knowledge/note",
      content: "small-blob-test",
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "test" },
      schema_version: 1,
    });
    const db = activeDbFor(ORG);
    const row = db
      .prepare(`SELECT compression, content IS NULL AS is_null FROM artifacts WHERE hash = ?`)
      .get(r.hash) as { compression: string; is_null: number };
    expect(row.compression).toBe("none");
    expect(row.is_null).toBe(0);
    expect(hasCasBlob(ORG, r.hash)).toBe(false);
  });

  test("large blob routes to CAS with compression='cas'", () => {
    const big = "x".repeat(BRAIN_LARGE_BLOB_THRESHOLD + 1024);
    const r = ingest({
      kind: "code/blob",
      content: big,
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "test" },
      schema_version: 1,
    });
    const db = activeDbFor(ORG);
    const row = db
      .prepare(`SELECT compression, content IS NULL AS is_null FROM artifacts WHERE hash = ?`)
      .get(r.hash) as { compression: string; is_null: number };
    expect(row.compression).toBe("cas");
    expect(row.is_null).toBe(1);
    expect(hasCasBlob(ORG, r.hash)).toBe(true);
    expect(verifyCasBlob(ORG, r.hash)).toBe(true);
  });

  test("CAS content round-trips byte-for-byte", () => {
    const content = "round-trip-" + "a".repeat(BRAIN_LARGE_BLOB_THRESHOLD);
    const r = ingest({
      kind: "code/blob",
      content,
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "test" },
      schema_version: 1,
    });
    const blob = readCasBlob(ORG, r.hash);
    expect(blob.toString("utf8")).toBe(content);
    const h = createHash("sha256").update(blob).digest("hex");
    expect(h).toBe(r.hash);
  });
});

describe("brain phase 5 — code symbol extraction", () => {
  test("extracts TypeScript functions, classes, interfaces", () => {
    const text = `
export function alpha(): number { return 1; }
export const beta = (x: number) => x + 1;
export class Gamma extends Base {}
export interface Delta { x: number; }
import { thing } from "./thing.js";
`.trim();
    const symbols = extractSymbols({
      hash: "abc",
      text,
      file_path: "x.ts",
      project_id: PROJ,
      org_id: ORG,
    });
    const names = new Set(symbols.map((s) => s.symbol));
    expect(names.has("alpha")).toBe(true);
    expect(names.has("beta")).toBe(true);
    expect(names.has("Gamma")).toBe(true);
    expect(names.has("Delta")).toBe(true);
    expect(names.has("./thing.js")).toBe(true);
  });

  test("extracts Python def and class", () => {
    const text = `
def alpha():
    pass

class Bravo:
    pass

from os import path
`.trim();
    const symbols = extractSymbols({
      hash: "py",
      text,
      file_path: "x.py",
      project_id: PROJ,
      org_id: ORG,
    });
    const names = new Set(symbols.map((s) => s.symbol));
    expect(names.has("alpha")).toBe(true);
    expect(names.has("Bravo")).toBe(true);
    expect(names.has("os")).toBe(true);
  });

  test("extracts Go funcs + types", () => {
    const text = `
package foo

func Handler(w http.ResponseWriter, r *http.Request) {}
func (s *Server) Start() {}

type Server struct {}
type Listener interface {}

import "net/http"
`.trim();
    const symbols = extractSymbols({
      hash: "go",
      text,
      file_path: "x.go",
      project_id: PROJ,
      org_id: ORG,
    });
    const names = new Set(symbols.map((s) => s.symbol));
    expect(names.has("Handler")).toBe(true);
    expect(names.has("Start")).toBe(true);
    expect(names.has("Server")).toBe(true);
    expect(names.has("Listener")).toBe(true);
    expect(names.has("net/http")).toBe(true);
  });

  test("runCodeSymbolExtraction populates code_symbols table", () => {
    const db = activeDbFor(ORG);
    const hash = "0".repeat(64);
    // Seed an artifact row directly so the extractor has something to ref.
    db.prepare(
      `INSERT OR IGNORE INTO artifacts
       (hash, kind, ts, org_id, project_id, origin_tool, size, compression, schema_version, kind_specific_meta)
       VALUES (?, 'code/blob', ?, ?, ?, 'test', 0, 'none', 1, '{}')`,
    ).run(hash, Math.floor(Date.now() / 1000), ORG, PROJ);

    const ok = runCodeSymbolExtraction({
      hash,
      text: "export function extractorRunTest() {}",
      file_path: "test.ts",
      project_id: PROJ,
      org_id: ORG,
    });
    expect(ok).toBe(true);

    const rows = db
      .prepare(`SELECT symbol FROM code_symbols WHERE hash = ?`)
      .all(hash) as Array<{ symbol: string }>;
    expect(rows.map((r) => r.symbol)).toContain("extractorRunTest");
  });
});

describe("brain phase 5 — code-structural retriever", () => {
  test("finds artifact via symbol name through search orchestrator", async () => {
    // Ingest a code file with a distinctive symbol
    const src = `
export function uniqueSymbolMarker42() { return 1; }
export class HelperClass {}
`.trim();
    const r = ingest({
      kind: "code/blob",
      content: src,
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "test" },
      kind_specific_meta: { file_path: "src/helper.ts" },
      schema_version: 1,
    });

    // Force-run code extraction synchronously so the test doesn't race the queue
    runCodeSymbolExtraction({
      hash: r.hash,
      text: src,
      file_path: "src/helper.ts",
      project_id: PROJ,
      org_id: ORG,
    });

    const response = await search(
      QuerySpec.parse({
        org_id: ORG,
        project_id: PROJ,
        text: { query: "uniqueSymbolMarker42", mode: "lexical" },
        intent: "find_code",
        return_score_breakdown: true,
      }),
    );
    const hashes = response.results.map((x) => x.hash);
    expect(hashes).toContain(r.hash);
  });
});

describe("brain phase 5 — image extractor scaffold", () => {
  test("no providers → records 'skipped'", async () => {
    resetImageProviders();
    const fakePng = Buffer.from("not a real png but ok for the test");
    const db = activeDbFor(ORG);
    const beforeRuns = (
      db.prepare("SELECT COUNT(*) AS c FROM extractor_runs WHERE extractor = 'image_extractors'").get() as { c: number }
    ).c;
    await runImageExtraction({
      hash: "f".repeat(64),
      buffer: fakePng,
      project_id: PROJ,
      org_id: ORG,
    });
    const afterRuns = (
      db.prepare("SELECT COUNT(*) AS c FROM extractor_runs WHERE extractor = 'image_extractors'").get() as { c: number }
    ).c;
    expect(afterRuns - beforeRuns).toBe(1);
    const run = db
      .prepare("SELECT result, error FROM extractor_runs WHERE extractor = 'image_extractors' ORDER BY ts DESC LIMIT 1")
      .get() as { result: string; error: string };
    expect(run.result).toBe("skipped");
  });

  test("custom phash provider populates image_features.phash", async () => {
    const fakeProvider: PhashProvider = {
      name: "test-phash",
      async compute() {
        // SQLite INTEGER is signed 64-bit; keep within that range.
        return 0x5EADBEEFCAFEBABEn;
      },
    };
    const captionProvider: CaptionProvider = {
      name: "test-caption",
      async caption() {
        return "a test caption";
      },
    };
    setImageProviders({ phash: fakeProvider, caption: captionProvider });

    const target: ImageExtractTarget = {
      hash: "1".repeat(64),
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      project_id: PROJ,
      org_id: ORG,
      mime: "image/png",
    };
    await runImageExtraction(target);

    const db = activeDbFor(ORG);
    const row = db
      .prepare("SELECT phash, caption FROM image_features WHERE hash = ?")
      .safeIntegers(true)
      .get(target.hash) as { phash: bigint; caption: string } | undefined;
    expect(row).toBeTruthy();
    expect(row!.phash).toBe(0x5EADBEEFCAFEBABEn);
    expect(row!.caption).toBe("a test caption");

    resetImageProviders();
  });
});

describe("brain phase 5 — perceptual retriever", () => {
  test("finds near-duplicate image by pHash", async () => {
    // Seed two image artifacts with deterministic pHashes
    const imgA = ingest({
      kind: "media/image/screenshot",
      content: Buffer.from([0x01, 0x02, 0x03]).toString("base64"),
      content_type: "image/png",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "test" },
      schema_version: 1,
    });
    const imgB = ingest({
      kind: "media/image/screenshot",
      content: Buffer.from([0x04, 0x05, 0x06]).toString("base64"),
      content_type: "image/png",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "test" },
      schema_version: 1,
    });

    const db = activeDbFor(ORG);
    // Set two pHashes 4 bits apart (within DEFAULT_HAMMING_CEILING=12).
    // Keep within signed int64 range that SQLite/better-sqlite3 accept.
    const phashA = 0x7FFFFFFFFFFFFFFFn;
    const phashB = 0x7FFFFFFFFFFFFFF0n; // differs in last 4 bits
    db.prepare(
      `INSERT OR REPLACE INTO image_features (hash, phash, extracted_at) VALUES (?, ?, ?)`,
    ).run(imgA.hash, phashA, Math.floor(Date.now() / 1000));
    db.prepare(
      `INSERT OR REPLACE INTO image_features (hash, phash, extracted_at) VALUES (?, ?, ?)`,
    ).run(imgB.hash, phashB, Math.floor(Date.now() / 1000));

    const q = QuerySpec.parse({
      org_id: ORG,
      project_id: PROJ,
      image: { vector_ref: imgA.hash, weight: 1.0 },
    });
    const results = runPerceptualImage(db, q, 10);
    // imgA excluded (itself), imgB should show up with low Hamming distance
    const hashes = results.map((r) => r.hash);
    expect(hashes).toContain(imgB.hash);
    expect(hashes).not.toContain(imgA.hash);
  });
});
