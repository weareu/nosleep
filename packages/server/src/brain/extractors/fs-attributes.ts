/**
 * Filesystem attribute extractor. For code/file_snapshot artifacts where
 * kind_specific_meta.file_path points at a real file on disk, capture
 * mtime/ctime/size/mode into artifact_num_meta so numeric filters work.
 *
 * Sync and fast — fs.statSync is microseconds. Swallows all errors so a
 * missing file or permission denial doesn't fail ingest.
 */

import { nanoid } from "nanoid";
import fs from "node:fs";
import path from "node:path";
import { activeDbFor } from "../storage/active-db.js";

export interface FsAttrTarget {
  hash: string;
  file_path: string;
  project_id: string;
  org_id: string;
}

export interface FsAttrs {
  size: number;
  mtime: number;
  ctime: number;
  atime: number;
  mode_octal: string;
  uid: number;
  gid: number;
  is_dir: boolean;
  is_symlink: boolean;
  extension: string | null;
}

export function statToAttrs(p: string): FsAttrs | null {
  try {
    const lst = fs.lstatSync(p);
    const st = lst.isSymbolicLink() ? fs.statSync(p) : lst;
    return {
      size: st.size,
      mtime: Math.floor(st.mtimeMs / 1000),
      ctime: Math.floor(st.ctimeMs / 1000),
      atime: Math.floor(st.atimeMs / 1000),
      mode_octal: (st.mode & 0o7777).toString(8),
      uid: st.uid,
      gid: st.gid,
      is_dir: st.isDirectory(),
      is_symlink: lst.isSymbolicLink(),
      extension: path.extname(p) || null,
    };
  } catch {
    return null;
  }
}

export function runFsAttrExtraction(target: FsAttrTarget): boolean {
  if (!path.isAbsolute(target.file_path)) return false;
  const attrs = statToAttrs(target.file_path);
  if (!attrs) {
    recordRun(target, "skipped", "stat failed");
    return false;
  }

  const db = activeDbFor(target.org_id);
  const started = performance.now();

  const tx = db.transaction(() => {
    const insertNum = db.prepare(
      `INSERT OR REPLACE INTO artifact_num_meta (hash, key, value) VALUES (?, ?, ?)`,
    );
    insertNum.run(target.hash, "fs.size", attrs.size);
    insertNum.run(target.hash, "fs.mtime", attrs.mtime);
    insertNum.run(target.hash, "fs.ctime", attrs.ctime);
    insertNum.run(target.hash, "fs.atime", attrs.atime);
    insertNum.run(target.hash, "fs.uid", attrs.uid);
    insertNum.run(target.hash, "fs.gid", attrs.gid);

    // Merge attrs into kind_specific_meta for human inspection
    const row = db
      .prepare(`SELECT kind_specific_meta FROM artifacts WHERE hash = ?`)
      .get(target.hash) as { kind_specific_meta: string } | undefined;
    if (row) {
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(row.kind_specific_meta) as Record<string, unknown>;
      } catch {
        /* overwrite */
      }
      meta.fs = attrs;
      // Artifacts are append-only via trigger on content/kind, but
      // kind_specific_meta is NOT in the immutable list, so this UPDATE is
      // allowed.
      db.prepare(
        `UPDATE artifacts SET kind_specific_meta = ? WHERE hash = ?`,
      ).run(JSON.stringify(meta), target.hash);
    }
  });

  try {
    tx();
    recordRun(target, "success", `size=${attrs.size}`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    recordRun(target, "failed", msg);
    return false;
  }
  void started;
}

function recordRun(
  target: FsAttrTarget,
  result: "success" | "failed" | "skipped",
  note: string,
): void {
  const db = activeDbFor(target.org_id);
  try {
    db.prepare(
      `INSERT INTO extractor_runs
       (run_id, ts, extractor, extractor_version, prompt_version, model,
        artifact_hash, duration_ms, result, error,
        project_id, org_id)
       VALUES (?, ?, 'fs_attributes', '0.1.0', NULL, NULL, ?, 0, ?, ?, ?, ?)`,
    ).run(
      nanoid(),
      Math.floor(Date.now() / 1000),
      target.hash,
      result,
      note,
      target.project_id,
      target.org_id,
    );
  } catch {
    /* audit best-effort */
  }
}
