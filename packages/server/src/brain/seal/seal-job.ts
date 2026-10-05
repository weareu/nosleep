/**
 * Seal job. Creates a snapshot of an org's active.db as a sealed file under
 * data/brain/<org>/sealed/sealed-YYYY-QN.db, builds a per-file HNSW index
 * over its vec_text rows, computes the SHA-256, and registers the file in
 * catalog.db.sealed_files.
 *
 * Phase 8 v1 ships seal-as-snapshot only — active.db is NOT rotated /
 * truncated. Sealed files exist for cold backup and per-quarter
 * corruption isolation. Phase 8 v2 can add rotation once the trigger
 * bypass mechanism is in.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { brainPathsFor } from "../storage/paths.js";
import { activeDbFor } from "../storage/active-db.js";
import { catalogDbFor } from "../storage/catalog-db.js";
import { loadBrainVecExtension, isVecLoaded } from "../storage/vec-loader.js";
import { observe } from "../metrics/emit.js";
import { METRIC_KEYS } from "../metrics/canonical-keys.js";

export interface SealOptions {
  quarter?: string;
  skip_hnsw?: boolean;
  org_id: string;
}

export interface SealResult {
  file_name: string;
  path: string;
  size_bytes: number;
  verify_hash: string;
  artifact_count: number;
  ts_from: number | null;
  ts_to: number | null;
  hnsw_built: boolean;
  hnsw_size_bytes: number;
  duration_ms: number;
}

function currentQuarter(d: Date = new Date()): string {
  const y = d.getUTCFullYear();
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${y}-Q${q}`;
}

interface UsearchIndex {
  add(key: bigint, vector: Float32Array): void;
  save(path: string): void;
}

export async function sealActiveDb(opts: SealOptions): Promise<SealResult> {
  const started = performance.now();
  const orgId = opts.org_id;
  const quarter = opts.quarter ?? currentQuarter();
  const paths = brainPathsFor(orgId);
  const fileName = `sealed-${quarter}.db`;
  const target = path.join(paths.sealedDir, fileName);

  if (fs.existsSync(target)) {
    const moved = `${target}.pre-reseal-${Math.floor(Date.now() / 1000)}`;
    fs.renameSync(target, moved);
  }

  // 1. Online backup of active.db → target.
  const activeDb = activeDbFor(orgId);
  await activeDb.backup(target);

  // 2. Open the sealed copy. Inspect counts + ts range, optionally build
  //    HNSW index inline.
  const sealed = new Database(target);

  const counts = sealed
    .prepare(
      `SELECT COUNT(*) AS c, MIN(ts) AS ts_from, MAX(ts) AS ts_to FROM artifacts`,
    )
    .get() as { c: number; ts_from: number | null; ts_to: number | null };

  let hnswBuilt = false;
  let hnswBytes = 0;

  if (!opts.skip_hnsw) {
    try {
      loadBrainVecExtension(sealed);
      if (isVecLoaded(sealed)) {
        const built = await buildHnswForSealedFile(sealed);
        hnswBuilt = built.built;
        hnswBytes = built.size;
      }
    } catch {
      /* HNSW build is best-effort */
    }
  }

  sealed.close();

  // 3. Hash the final sealed file (after HNSW writes)
  const finalBuf = fs.readFileSync(target);
  const finalHash = createHash("sha256").update(finalBuf).digest("hex");
  const finalSize = finalBuf.length;

  // 4. Register in catalog.db.sealed_files
  const catalog = catalogDbFor(orgId);
  catalog
    .prepare(
      `INSERT OR REPLACE INTO sealed_files
       (file_name, org_id, quarter, ts_from, ts_to, size_bytes,
        artifact_count, verify_hash, verified_at, compression_ratio)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fileName,
      orgId,
      quarter,
      // catalog schema marks ts_from/ts_to NOT NULL; default to seal time
      // when the active DB has no artifacts yet.
      counts.ts_from ?? Math.floor(Date.now() / 1000),
      counts.ts_to ?? Math.floor(Date.now() / 1000),
      finalSize,
      counts.c,
      finalHash,
      Math.floor(Date.now() / 1000),
      0,
    );

  // 5. Storage metrics
  observe(METRIC_KEYS.storage_sealed_bytes, finalSize, orgId, "_org_level", {
    quarter,
  });

  return {
    file_name: fileName,
    path: target,
    size_bytes: finalSize,
    verify_hash: finalHash,
    artifact_count: counts.c,
    ts_from: counts.ts_from,
    ts_to: counts.ts_to,
    hnsw_built: hnswBuilt,
    hnsw_size_bytes: hnswBytes,
    duration_ms: performance.now() - started,
  };
}

async function buildHnswForSealedFile(
  sealed: Database.Database,
): Promise<{ built: boolean; size: number }> {
  let UsearchModule: { Index: new (opts: { metric: string; dimensions: number }) => UsearchIndex };
  try {
    UsearchModule = (await import("usearch")) as unknown as typeof UsearchModule;
  } catch {
    return { built: false, size: 0 };
  }

  const dim = 384;
  const rows = sealed
    .prepare(`SELECT v.rowid AS rowid, v.embedding AS embedding FROM vec_text v`)
    .all() as Array<{ rowid: number | bigint; embedding: Buffer }>;

  if (rows.length === 0) return { built: false, size: 0 };

  const idx = new UsearchModule.Index({ metric: "cos", dimensions: dim });
  for (const r of rows) {
    const vec = new Float32Array(
      r.embedding.buffer,
      r.embedding.byteOffset,
      Math.floor(r.embedding.byteLength / 4),
    );
    if (vec.length !== dim) continue;
    idx.add(BigInt(typeof r.rowid === "bigint" ? r.rowid : r.rowid), vec);
  }

  const os = await import("node:os");
  const tmp = path.join(
    os.tmpdir(),
    `nosleep-hnsw-${Date.now()}-${process.pid}.usearch`,
  );
  idx.save(tmp);
  const blob = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);

  sealed
    .prepare(
      `INSERT OR REPLACE INTO vec_hnsw_blob (index_name, dim, size, blob, built_at)
       VALUES ('vec_text', ?, ?, ?, ?)`,
    )
    .run(dim, rows.length, blob, Math.floor(Date.now() / 1000));

  return { built: true, size: blob.length };
}
