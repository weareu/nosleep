/**
 * Warmth job. Reads the first ~1MB of each sealed file weekly to keep
 * commonly-accessed pages in the OS cache. Stale sealed files lose their
 * cache and incur 50–200ms first-page latency on a cold query.
 */

import fs from "node:fs";
import path from "node:path";
import { brainPathsFor } from "../storage/paths.js";
import { catalogDbFor } from "../storage/catalog-db.js";

const WARM_BYTES = 1 * 1024 * 1024;

export interface WarmthResult {
  file_name: string;
  bytes_read: number;
  ok: boolean;
  error: string | null;
}

export function warmAllSealedFiles(orgId: string): WarmthResult[] {
  const paths = brainPathsFor(orgId);
  const catalog = catalogDbFor(orgId);
  const rows = catalog
    .prepare(`SELECT file_name FROM sealed_files WHERE org_id = ?`)
    .all(orgId) as Array<{ file_name: string }>;

  return rows.map((r) => {
    const fpath = path.join(paths.sealedDir, r.file_name);
    if (!fs.existsSync(fpath)) {
      return {
        file_name: r.file_name,
        bytes_read: 0,
        ok: false,
        error: "file missing",
      };
    }
    try {
      const fd = fs.openSync(fpath, "r");
      try {
        const buf = Buffer.alloc(WARM_BYTES);
        const n = fs.readSync(fd, buf, 0, WARM_BYTES, 0);
        return { file_name: r.file_name, bytes_read: n, ok: true, error: null };
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      return {
        file_name: r.file_name,
        bytes_read: 0,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}
