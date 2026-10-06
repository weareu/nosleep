/**
 * Phase 5-finish — image + code list endpoint tests against the
 * underlying functions (route handlers thin-wrap the same SQL).
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-brain-listep-"));
process.env.NOSLEEP_DATA_DIR = tmpDataDir;

import { ingest } from "../ingest/pipeline.js";
import { runCodeSymbolExtraction } from "../extractors/code-symbols.js";
import { activeDbFor, closeAllBrainDbs } from "../storage/active-db.js";
import { registerBrainImageListRoutes } from "../routes/images.js";

const ORG = "org_listep_test";
const PROJ = "proj_listep";

beforeAll(() => {
  activeDbFor(ORG);
});

afterAll(() => {
  closeAllBrainDbs();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("phase 5-finish — images list", () => {
  test("returns image artifacts only", () => {
    const img = ingest({
      kind: "media/image/screenshot",
      content: Buffer.from([0, 1, 2, 3]).toString("base64"),
      content_type: "image/png",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "test" },
      schema_version: 1,
    });
    ingest({
      kind: "knowledge/note",
      content: "not an image",
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "test" },
      schema_version: 1,
    });

    const db = activeDbFor(ORG);
    const rows = db
      .prepare(
        `SELECT a.hash FROM artifacts a
       LEFT JOIN image_features img ON img.hash = a.hash
       WHERE a.kind GLOB 'media/image/*' AND a.org_id = ? AND a.project_id = ?`,
      )
      .all(ORG, PROJ) as Array<{ hash: string }>;
    expect(rows.map((r) => r.hash)).toContain(img.hash);
  });

  test("phash clustering groups near-duplicates", () => {
    const a = ingest({
      kind: "media/image/screenshot",
      content: Buffer.from([10, 11]).toString("base64"),
      content_type: "image/png",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "test" },
      schema_version: 1,
    });
    const b = ingest({
      kind: "media/image/screenshot",
      content: Buffer.from([12, 13]).toString("base64"),
      content_type: "image/png",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "test" },
      schema_version: 1,
    });
    const db = activeDbFor(ORG);
    db.prepare(
      `INSERT OR REPLACE INTO image_features (hash, phash, extracted_at) VALUES (?, ?, ?)`,
    ).run(a.hash, 0x7FFFFFFFFFFFFFFFn, Math.floor(Date.now() / 1000));
    db.prepare(
      `INSERT OR REPLACE INTO image_features (hash, phash, extracted_at) VALUES (?, ?, ?)`,
    ).run(b.hash, 0x7FFFFFFFFFFFFFF0n, Math.floor(Date.now() / 1000));

    // Inline cluster math identical to routes/images.ts
    const rows = db
      .prepare(
        `SELECT a.hash AS hash, img.phash AS phash FROM artifacts a
         JOIN image_features img ON img.hash = a.hash
         WHERE a.kind GLOB 'media/image/*' AND a.project_id = ?`,
      )
      .safeIntegers(true)
      .all(PROJ) as Array<{ hash: string; phash: bigint }>;

    const clusters: Array<string[]> = [];
    const claimed = new Set<string>();
    for (const r of rows) {
      if (claimed.has(r.hash)) continue;
      const cluster = [r.hash];
      claimed.add(r.hash);
      for (const o of rows) {
        if (claimed.has(o.hash)) continue;
        let x = r.phash ^ o.phash;
        let h = 0;
        while (x !== 0n) {
          h += Number(x & 1n);
          x >>= 1n;
        }
        if (h <= 8) {
          cluster.push(o.hash);
          claimed.add(o.hash);
        }
      }
      clusters.push(cluster);
    }
    // a + b should have clustered (Hamming = 4 ≤ 8)
    const merged = clusters.find((c) => c.length === 2 && c.includes(a.hash));
    expect(merged).toBeDefined();
    expect(merged!.includes(b.hash)).toBe(true);
  });
});

describe("phase 5-finish — code list", () => {
  test("symbols list filters by query and kind", () => {
    const r = ingest({
      kind: "code/blob",
      content: "export function alphaListEp() { return 1; }\nexport class BetaListEp {}",
      content_type: "text/plain",
      org_id: ORG,
      project_id: PROJ,
      origin: { tool: "test" },
      kind_specific_meta: { file_path: "src/listep.ts" },
      schema_version: 1,
    });
    runCodeSymbolExtraction({
      hash: r.hash,
      text: "export function alphaListEp() { return 1; }\nexport class BetaListEp {}",
      file_path: "src/listep.ts",
      project_id: PROJ,
      org_id: ORG,
    });

    const db = activeDbFor(ORG);
    const rows = db
      .prepare(
        `SELECT cs.symbol FROM code_symbols cs
         JOIN artifacts a ON a.hash = cs.hash
         WHERE a.org_id = ? AND a.project_id = ?
           AND (cs.symbol GLOB ? OR cs.file_path GLOB ?)`,
      )
      .all(ORG, PROJ, "*alpha*", "*alpha*") as Array<{ symbol: string }>;
    expect(rows.map((r) => r.symbol)).toContain("alphaListEp");
  });

  test("files list distincts by file_path", () => {
    const db = activeDbFor(ORG);
    const rows = db
      .prepare(
        `SELECT cs.file_path AS file_path, COUNT(DISTINCT cs.hash) AS snapshots,
                COUNT(*) AS symbol_count
         FROM code_symbols cs
         JOIN artifacts a ON a.hash = cs.hash
         WHERE a.org_id = ? AND a.project_id = ? AND cs.file_path IS NOT NULL
         GROUP BY cs.file_path`,
      )
      .all(ORG, PROJ) as Array<{
      file_path: string;
      snapshots: number;
      symbol_count: number;
    }>;
    const listep = rows.find((r) => r.file_path === "src/listep.ts");
    expect(listep).toBeDefined();
    expect(listep!.snapshots).toBeGreaterThan(0);
    expect(listep!.symbol_count).toBeGreaterThanOrEqual(2);
  });
});

describe("GET /api/brain/images (route)", () => {
  // Regression: the query runs with safeIntegers(true), so width/height came
  // back as BigInt and JSON serialisation threw ("Do not know how to
  // serialize a BigInt") — every phone photo (which carries dimensions)
  // made the images list 500, so uploaded photos never showed up.
  test("serialises a photo that has width/height + phash", async () => {
    const proj = "proj_listep_route";
    const img = ingest({
      kind: "media/image/photo",
      content: Buffer.from([9, 8, 7, 6, 5]).toString("base64"),
      content_type: "image/jpeg",
      org_id: ORG,
      project_id: proj,
      origin: { tool: "nosleep-mobile", actor: "user" },
      kind_specific_meta: { width: 1600, height: 1200 },
      schema_version: 1,
    });
    activeDbFor(ORG)
      .prepare(
        `INSERT OR REPLACE INTO image_features (hash, phash, width, height, mime, extracted_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(img.hash, -0x0f0f0f0f0f0f0f0fn, 1600, 1200, "image/jpeg", 1);

    const app = Fastify({ logger: false });
    registerBrainImageListRoutes(app);
    const res = await app.inject({
      method: "GET",
      url: `/api/brain/images?org_id=${ORG}&project_id=${proj}&cluster=phash`,
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      hash: img.hash,
      kind: "media/image/photo",
      width: 1600,
      height: 1200,
      phash: (-0x0f0f0f0f0f0f0f0fn).toString(),
    });
    expect(typeof body.items[0].ts).toBe("number");
    expect(body.clusters).toEqual([{ representative: img.hash, size: 1, hashes: [img.hash] }]);
  });
});
