/**
 * Phase 8 tests — seal job, verify-hash, warmth, file selection. Skip HNSW
 * by default to keep test runtime tight; the HNSW path is exercised in a
 * dedicated test below.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-brain-seal-"));
process.env.NOSLEEP_DATA_DIR = tmpDataDir;

import Database from "better-sqlite3";
import { ingest } from "../ingest/pipeline.js";
import { sealActiveDb } from "../seal/seal-job.js";
import { verifyAllSealedFiles } from "../seal/verify.js";
import { warmAllSealedFiles } from "../seal/warmth.js";
import { selectFiles } from "../storage/file-selection.js";
import { activeDbFor, closeAllBrainDbs } from "../storage/active-db.js";

const ORG = "org_seal_test";
const PROJ = "proj_seal";

beforeAll(() => {
  activeDbFor(ORG);
});

afterAll(() => {
  closeAllBrainDbs();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("phase 8 — seal", () => {
  test("seals an empty active.db successfully", async () => {
    const result = await sealActiveDb({
      org_id: ORG,
      quarter: "2099-Q1",
      skip_hnsw: true,
    });
    expect(result.file_name).toBe("sealed-2099-Q1.db");
    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.size_bytes).toBeGreaterThan(0);
    expect(result.verify_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("sealed file contains all artifacts", async () => {
    ingest({
      kind: "knowledge/note",
      content: "seal test artifact 1",
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "test" },
      schema_version: 1,
    });
    ingest({
      kind: "knowledge/note",
      content: "seal test artifact 2",
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "test" },
      schema_version: 1,
    });
    const result = await sealActiveDb({
      org_id: ORG,
      quarter: "2099-Q2",
      skip_hnsw: true,
    });
    expect(result.artifact_count).toBeGreaterThanOrEqual(2);

    const sealed = new Database(result.path, { readonly: true });
    const count = (
      sealed.prepare("SELECT COUNT(*) AS c FROM artifacts").get() as { c: number }
    ).c;
    sealed.close();
    expect(count).toBe(result.artifact_count);
  });

  test("re-seal moves prior sealed file aside", async () => {
    await sealActiveDb({ org_id: ORG, quarter: "2099-Q3", skip_hnsw: true });
    await sealActiveDb({ org_id: ORG, quarter: "2099-Q3", skip_hnsw: true });
    const sealedDir = path.join(tmpDataDir, "brain", ORG, "sealed");
    const files = fs.readdirSync(sealedDir);
    const preReseal = files.filter((f) => f.includes("pre-reseal"));
    expect(preReseal.length).toBeGreaterThan(0);
  });

  test("seal with HNSW builds vec_hnsw_blob row", async () => {
    // Seed enough vectors that a meaningful HNSW exists. We bypass the real
    // embedder and write directly into vec_text + vec_text_map.
    const db = activeDbFor(ORG);
    const vec = (n: number) => {
      const f = new Float32Array(384);
      for (let i = 0; i < 384; i++) f[i] = Math.sin(n * 0.1 + i * 0.01);
      return Buffer.from(f.buffer);
    };
    const tx = db.transaction(() => {
      for (let i = 0; i < 8; i++) {
        const ins = db
          .prepare(`INSERT INTO vec_text (embedding) VALUES (?)`)
          .run(vec(i));
        const rowid = Number(ins.lastInsertRowid);
        db.prepare(
          `INSERT INTO vec_text_map (rowid, hash, referrer_kind, chunk_ord, chunk_text, embedded_at)
           VALUES (?, ?, 'artifact', 0, ?, ?)`,
        ).run(rowid, "h" + i.toString().padStart(63, "0"), `chunk ${i}`, Math.floor(Date.now() / 1000));
      }
    });
    tx();

    const result = await sealActiveDb({
      org_id: ORG,
      quarter: "2099-Q4",
      skip_hnsw: false,
    });
    expect(result.hnsw_built).toBe(true);
    expect(result.hnsw_size_bytes).toBeGreaterThan(0);

    const sealed = new Database(result.path, { readonly: true });
    const row = sealed
      .prepare(`SELECT dim, size FROM vec_hnsw_blob WHERE index_name = 'vec_text'`)
      .get() as { dim: number; size: number } | undefined;
    sealed.close();
    expect(row).toBeDefined();
    expect(row!.dim).toBe(384);
    expect(row!.size).toBeGreaterThanOrEqual(8);
  }, 60_000);
});

describe("phase 8 — verify", () => {
  test("verify reports OK for untouched sealed files", () => {
    const results = verifyAllSealedFiles(ORG);
    expect(results.length).toBeGreaterThan(0);
    const allOk = results.every((r) => r.ok);
    expect(allOk).toBe(true);
  });

  test("verify detects tampered sealed file", async () => {
    const result = await sealActiveDb({
      org_id: ORG,
      quarter: "2099-Q5",
      skip_hnsw: true,
    });
    // Tamper: append a byte so the hash mismatches.
    fs.appendFileSync(result.path, Buffer.from([0x00]));
    const verifies = verifyAllSealedFiles(ORG);
    const tamperedRow = verifies.find((v) => v.file_name === result.file_name);
    expect(tamperedRow).toBeDefined();
    expect(tamperedRow!.ok).toBe(false);
    expect(tamperedRow!.error).toContain("hash mismatch");
  });
});

describe("phase 8 — warmth", () => {
  test("warmth touches each sealed file", () => {
    const results = warmAllSealedFiles(ORG);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      // Some may have been deleted in re-seal tests; just check the OK ones
      // touched bytes.
      if (r.ok) expect(r.bytes_read).toBeGreaterThan(0);
    }
  });
});

describe("phase 8 — file selection", () => {
  test("active-only by default", () => {
    const files = selectFiles({ org_id: ORG });
    expect(files.length).toBe(1);
    expect(files[0].kind).toBe("active");
  });

  test("include_sealed surfaces catalog rows", () => {
    const files = selectFiles({ org_id: ORG, include_sealed: true });
    expect(files.length).toBeGreaterThan(1);
    const sealed = files.filter((f) => f.kind === "sealed");
    expect(sealed.length).toBeGreaterThan(0);
    expect(sealed[0].alias).toMatch(/^s\d+$/);
  });
});
