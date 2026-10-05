/**
 * Disk-headroom guard for brain ingestion.
 *
 * The brain DB grows with every ingested turn; when the disk actually filled,
 * SQLite threw "database or disk is full" / "disk I/O error" mid-write and the
 * server died in a crash-restart cascade (2026-07-15: heap OOM + two silent
 * restarts). Writing until the disk is full is never acceptable — ingest is
 * best-effort capture, the SERVER STAYING UP is the contract.
 *
 * Cheap statfs check, cached for 30s. Below the floor, ingest callers skip
 * writes and report why; the scheduler raises a dashboard alert.
 */

import { statfsSync } from "node:fs";

const MIN_FREE_GB = Number(process.env.NOSLEEP_MIN_FREE_DISK_GB ?? "5");
const CACHE_MS = 30_000;

interface DiskHeadroom {
  ok: boolean;
  freeGB: number;
}

let cached: DiskHeadroom & { at: number } = { ok: true, freeGB: Infinity, at: 0 };

export function diskHasHeadroom(probePath: string): DiskHeadroom {
  const now = Date.now();
  if (now - cached.at < CACHE_MS) return cached;
  try {
    const s = statfsSync(probePath);
    const freeGB = (s.bavail * s.bsize) / 1e9;
    cached = { ok: freeGB >= MIN_FREE_GB, freeGB, at: now };
  } catch {
    // Can't stat → don't block ingestion on a guard failure.
    cached = { ok: true, freeGB: Infinity, at: now };
  }
  return cached;
}

export { MIN_FREE_GB };
