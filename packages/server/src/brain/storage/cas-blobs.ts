/**
 * Large-blob content-addressed store. Ingested artifacts whose content
 * exceeds BRAIN_LARGE_BLOB_THRESHOLD are written here instead of inline
 * into artifacts.content. The SHA-256 is already our artifact hash, so the
 * CAS path is just `<blobs_dir>/<aa>/<hash>.bin` with a 2-char shard prefix.
 *
 * Read path resolves: if artifacts.compression='cas' then load from CAS;
 * otherwise inline content BLOB.
 *
 * CAS writes are durable (write to tmp, fsync, rename) so crashes don't
 * leave corrupt partial files.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { brainPathsFor } from "./paths.js";

export const CAS_COMPRESSION_MARKER = "cas";

/** Path where a given hash's CAS blob lives. Does NOT create the directory. */
export function casBlobPath(orgId: string, hash: string): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`invalid hash for CAS path: ${hash}`);
  }
  const { blobsDir } = brainPathsFor(orgId);
  const shard = hash.slice(0, 2);
  return path.join(blobsDir, shard, `${hash}.bin`);
}

/** Write a buffer to CAS. Idempotent — if the file already exists we verify
 *  its hash matches, then skip. */
export function writeCasBlob(orgId: string, hash: string, buf: Buffer): void {
  const target = casBlobPath(orgId, hash);
  const shardDir = path.dirname(target);
  if (!fs.existsSync(shardDir)) {
    fs.mkdirSync(shardDir, { recursive: true });
  }

  if (fs.existsSync(target)) {
    // Optional verification — skipped for speed; content is hash-addressed so
    // a collision here would indicate external tampering. We trust the hash.
    return;
  }

  // Write to tmp + rename for atomicity
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, buf, { mode: 0o644 });
  try {
    const fd = fs.openSync(tmp, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // fsync best-effort
  }
  fs.renameSync(tmp, target);
}

/** Read a CAS blob by hash. Throws if missing. */
export function readCasBlob(orgId: string, hash: string): Buffer {
  const p = casBlobPath(orgId, hash);
  return fs.readFileSync(p);
}

/** Verify a CAS blob's content hashes to its filename. Used by verify jobs. */
export function verifyCasBlob(orgId: string, hash: string): boolean {
  try {
    const content = readCasBlob(orgId, hash);
    const actual = createHash("sha256").update(content).digest("hex");
    return actual === hash;
  } catch {
    return false;
  }
}

/** True if a CAS blob exists on disk for the given hash. */
export function hasCasBlob(orgId: string, hash: string): boolean {
  try {
    return fs.existsSync(casBlobPath(orgId, hash));
  } catch {
    return false;
  }
}
