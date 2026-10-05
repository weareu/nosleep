/**
 * Verify sealed files. Re-hashes each registered sealed file and compares
 * to the catalog's verify_hash. Mismatches indicate bit-rot or external
 * tampering.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { brainPathsFor } from "../storage/paths.js";
import { catalogDbFor } from "../storage/catalog-db.js";

export interface VerifyResult {
  file_name: string;
  ok: boolean;
  expected_hash: string;
  actual_hash: string | null;
  size_bytes: number | null;
  error: string | null;
}

export function verifyAllSealedFiles(orgId: string): VerifyResult[] {
  const paths = brainPathsFor(orgId);
  const catalog = catalogDbFor(orgId);
  const rows = catalog
    .prepare(
      `SELECT file_name, verify_hash FROM sealed_files WHERE org_id = ?`,
    )
    .all(orgId) as Array<{ file_name: string; verify_hash: string }>;

  return rows.map((r) => {
    const fpath = path.join(paths.sealedDir, r.file_name);
    if (!fs.existsSync(fpath)) {
      return {
        file_name: r.file_name,
        ok: false,
        expected_hash: r.verify_hash,
        actual_hash: null,
        size_bytes: null,
        error: "file missing",
      };
    }
    try {
      const buf = fs.readFileSync(fpath);
      const actual = createHash("sha256").update(buf).digest("hex");
      const ok = actual === r.verify_hash;
      // Update verified_at on success so the dashboard reflects freshness.
      if (ok) {
        catalog
          .prepare(
            `UPDATE sealed_files SET verified_at = ? WHERE file_name = ?`,
          )
          .run(Math.floor(Date.now() / 1000), r.file_name);
      }
      return {
        file_name: r.file_name,
        ok,
        expected_hash: r.verify_hash,
        actual_hash: actual,
        size_bytes: buf.length,
        error: ok ? null : "hash mismatch — bit-rot or tampering suspected",
      };
    } catch (err) {
      return {
        file_name: r.file_name,
        ok: false,
        expected_hash: r.verify_hash,
        actual_hash: null,
        size_bytes: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}
