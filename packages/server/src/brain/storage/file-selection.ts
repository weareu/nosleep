/**
 * Smart catalog-driven file selection. Given a project + temporal range,
 * returns the list of sealed file paths that may contain matching data,
 * plus the active.db path. The retrieval pipeline ATTACHes these files
 * during query execution so BM25/semantic span the whole archive without
 * needing to know about sealing details.
 *
 * Phase 8 v1: catalog returns ALL sealed files for the org, optionally
 * filtered by `(ts_from <= to AND ts_to >= from)`. The query layer can
 * choose to use only the active DB (default) or fan out across all.
 */

import path from "node:path";
import fs from "node:fs";
import { brainPathsFor } from "./paths.js";
import { catalogDbFor } from "./catalog-db.js";

export interface SelectedFile {
  alias: string; // Distinct alias for ATTACH (s0, s1, ...)
  path: string;
  kind: "active" | "sealed";
  file_name: string;
  ts_from: number | null;
  ts_to: number | null;
}

export interface FileSelectionOptions {
  org_id: string;
  project_id?: string;
  ts_from?: number;
  ts_to?: number;
  /** When false, only returns the active DB (default — Phase 1-style queries). */
  include_sealed?: boolean;
}

export function selectFiles(
  opts: FileSelectionOptions,
): SelectedFile[] {
  const paths = brainPathsFor(opts.org_id);
  const out: SelectedFile[] = [
    {
      alias: "main",
      path: paths.activeDb,
      kind: "active",
      file_name: "active.db",
      ts_from: null,
      ts_to: null,
    },
  ];
  if (!opts.include_sealed) return out;

  const catalog = catalogDbFor(opts.org_id);
  const conds = ["org_id = ?"];
  const params: (string | number)[] = [opts.org_id];
  if (opts.ts_from !== undefined) {
    conds.push("ts_to >= ?");
    params.push(opts.ts_from);
  }
  if (opts.ts_to !== undefined) {
    conds.push("ts_from <= ?");
    params.push(opts.ts_to);
  }
  const rows = catalog
    .prepare(
      `SELECT file_name, ts_from, ts_to FROM sealed_files WHERE ${conds.join(" AND ")}
       ORDER BY ts_from ASC NULLS LAST`,
    )
    .all(...params) as Array<{
    file_name: string;
    ts_from: number | null;
    ts_to: number | null;
  }>;

  for (let i = 0; i < rows.length; i++) {
    const fpath = path.join(paths.sealedDir, rows[i].file_name);
    if (!fs.existsSync(fpath)) continue;
    out.push({
      alias: `s${i}`,
      path: fpath,
      kind: "sealed",
      file_name: rows[i].file_name,
      ts_from: rows[i].ts_from,
      ts_to: rows[i].ts_to,
    });
  }
  return out;
}

/**
 * Get an ATTACH-prefixed query template helper. Caller writes a query
 * referencing main + sN aliases; this returns the SQL to attach each.
 *
 * Note: this is a future-facing utility for fan-out queries. Phase 8 v1's
 * search.ts still queries main only; the selectFiles() helper exists so
 * Phase 9 polish can layer fan-out on top without revisiting the schema.
 */
export function attachStatements(files: SelectedFile[]): string[] {
  const sealed = files.filter((f) => f.kind === "sealed");
  return sealed.map((f) => `ATTACH DATABASE '${f.path}' AS ${f.alias}`);
}

export function detachStatements(files: SelectedFile[]): string[] {
  const sealed = files.filter((f) => f.kind === "sealed");
  return sealed.map((f) => `DETACH DATABASE ${f.alias}`);
}
