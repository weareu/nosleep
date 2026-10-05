/**
 * Git-blame authorship. For code artifacts with a real file_path, fetch
 * last author/commit from git. Non-blocking, swallows all errors — not
 * every code artifact comes from a git repo.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { activeDbFor } from "../storage/active-db.js";

const execFileAsync = promisify(execFile);

export interface GitAuthorshipTarget {
  hash: string;
  file_path: string;
  project_id: string;
  org_id: string;
}

export interface GitAuthorshipResult {
  last_author_name: string;
  last_author_email: string;
  last_commit_sha: string;
  last_commit_ts: number;
  last_commit_subject: string;
}

async function findGitRoot(filePath: string): Promise<string | null> {
  let dir = path.dirname(path.resolve(filePath));
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}

export async function fetchGitAuthorship(
  filePath: string,
): Promise<GitAuthorshipResult | null> {
  if (!path.isAbsolute(filePath)) return null;
  if (!fs.existsSync(filePath)) return null;
  const repoRoot = await findGitRoot(filePath);
  if (!repoRoot) return null;

  try {
    const relPath = path.relative(repoRoot, filePath);
    const { stdout } = await execFileAsync(
      "git",
      [
        "-C",
        repoRoot,
        "log",
        "-1",
        "--format=%H%x1f%an%x1f%ae%x1f%ct%x1f%s",
        "--",
        relPath,
      ],
      { timeout: 5_000 },
    );
    const line = stdout.trim();
    if (!line) return null;
    const [sha, name, email, ctStr, subject] = line.split("\x1f");
    const ct = Number(ctStr);
    if (!sha || !Number.isFinite(ct)) return null;
    return {
      last_author_name: name ?? "",
      last_author_email: email ?? "",
      last_commit_sha: sha,
      last_commit_ts: ct,
      last_commit_subject: subject ?? "",
    };
  } catch {
    return null;
  }
}

export async function runGitAuthorshipExtraction(
  target: GitAuthorshipTarget,
): Promise<boolean> {
  const result = await fetchGitAuthorship(target.file_path);
  if (!result) return false;

  const db = activeDbFor(target.org_id);
  const row = db
    .prepare(`SELECT kind_specific_meta FROM artifacts WHERE hash = ?`)
    .get(target.hash) as { kind_specific_meta: string } | undefined;
  if (!row) return false;

  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(row.kind_specific_meta) as Record<string, unknown>;
  } catch {
    /* overwrite */
  }
  meta.git = result;

  try {
    db.prepare(
      `UPDATE artifacts SET kind_specific_meta = ? WHERE hash = ?`,
    ).run(JSON.stringify(meta), target.hash);

    // Also index commit ts for temporal filtering
    db.prepare(
      `INSERT OR REPLACE INTO artifact_num_meta (hash, key, value) VALUES (?, 'git.last_commit_ts', ?)`,
    ).run(target.hash, result.last_commit_ts);
    return true;
  } catch {
    return false;
  }
}
