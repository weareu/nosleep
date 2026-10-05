/**
 * Per-org brain storage paths. Directory layout:
 *
 *   data/brain/<org_id>/
 *     active.db            — current quarter, writable
 *     catalog.db           — mutable metadata (project visibility, sealed registry)
 *     sealed/              — sealed-YYYY-QN.db files (Phase 8)
 *     blobs/               — large-blob CAS (Phase 5)
 */

import fs from "node:fs";
import path from "node:path";
import { getBrainRoot } from "../config.js";

export interface BrainPaths {
  orgDir: string;
  activeDb: string;
  catalogDb: string;
  sealedDir: string;
  blobsDir: string;
}

/**
 * Resolve paths for an org and ensure the directory tree exists.
 * Safe to call repeatedly (mkdir recursive + idempotent).
 */
export function brainPathsFor(orgId: string): BrainPaths {
  if (!orgId || !/^[a-zA-Z0-9_\-]+$/.test(orgId)) {
    throw new Error(`invalid org_id: ${orgId}`);
  }
  const orgDir = path.join(getBrainRoot(), orgId);
  const sealedDir = path.join(orgDir, "sealed");
  const blobsDir = path.join(orgDir, "blobs");

  fs.mkdirSync(orgDir, { recursive: true });
  fs.mkdirSync(sealedDir, { recursive: true });
  fs.mkdirSync(blobsDir, { recursive: true });

  return {
    orgDir,
    activeDb: path.join(orgDir, "active.db"),
    catalogDb: path.join(orgDir, "catalog.db"),
    sealedDir,
    blobsDir,
  };
}
