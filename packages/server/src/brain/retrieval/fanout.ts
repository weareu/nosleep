/**
 * Fan-out connection helper. Opens a fresh better-sqlite3 connection on the
 * active.db file, loads sqlite-vec, and ATTACHes every sealed file that
 * matches the query's temporal range. Retrievers can then query
 * `main.artifacts_fts`, `s0.artifacts_fts`, ... in a single UNION ALL.
 *
 * The cached active connection is NOT used here — ATTACH/DETACH on a shared
 * cached handle would race with concurrent queries. Fan-out queries are
 * comparatively rare (`time_range === "all_time"`), so the per-query
 * connection cost is acceptable.
 */

import Database from "better-sqlite3";
import {
  selectFiles,
  type SelectedFile,
} from "../storage/file-selection.js";
import { loadBrainVecExtension } from "../storage/vec-loader.js";
import type { QuerySpecT } from "./query-spec.js";

export interface FanoutHandle {
  db: Database.Database;
  files: SelectedFile[];
  close(): void;
}

/**
 * Should this query fan out across sealed files?
 * Returns the file list if so, otherwise null (caller falls back to the
 * cached active-only connection).
 */
export function planFanout(q: QuerySpecT): SelectedFile[] | null {
  if (q.time_range !== "all_time") return null;

  const files = selectFiles({
    org_id: q.org_id,
    project_id: q.scope === "project" ? q.project_id : undefined,
    ts_from: q.temporal?.from,
    ts_to: q.temporal?.to,
    include_sealed: true,
  });

  // Only worth opening a fan-out connection if there's at least one sealed
  // file. Otherwise the cached active-only handle is identical and faster.
  if (files.filter((f) => f.kind === "sealed").length === 0) return null;
  return files;
}

export function openFanout(files: SelectedFile[]): FanoutHandle {
  if (files.length === 0 || files[0].kind !== "active") {
    throw new Error("openFanout: first file must be the active.db");
  }

  const db = new Database(files[0].path, { readonly: true });
  db.pragma("busy_timeout = 5000");
  db.pragma("cache_size = -32000");
  db.pragma("mmap_size = 268435456");

  loadBrainVecExtension(db);

  for (const f of files) {
    if (f.kind === "sealed") {
      db.prepare(`ATTACH DATABASE ? AS ${f.alias}`).run(f.path);
    }
  }

  return {
    db,
    files,
    close: () => {
      try {
        for (const f of files) {
          if (f.kind === "sealed") {
            try {
              db.prepare(`DETACH DATABASE ${f.alias}`).run();
            } catch {
              /* ignore */
            }
          }
        }
        db.close();
      } catch {
        /* ignore */
      }
    },
  };
}
