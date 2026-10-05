/**
 * Brain-wide configuration constants.
 * Per-org/per-project overrides live in catalog.db.brain_config.
 */

import path from "node:path";

export const BRAIN_SCHEMA_VERSION = 1;

/**
 * Lazy resolution — env overrides are honoured whenever these are called,
 * not only at module load. Critical for tests that set env after importing.
 */
export function getNoSleepDataDir(): string {
  return process.env.NOSLEEP_DATA_DIR ?? path.join(process.cwd(), "data");
}

export function getBrainRoot(): string {
  return path.join(getNoSleepDataDir(), "brain");
}

export const BRAIN_INGEST_MAX_BYTES = 10 * 1024 * 1024; // 10 MB per request
export const BRAIN_KIND_META_MAX_BYTES = 32 * 1024; // 32 KB per kind_specific_meta JSON
export const BRAIN_LARGE_BLOB_THRESHOLD = 1 * 1024 * 1024; // 1 MB — above this, Phase 5 will use CAS; Phase 0 truncates

/** Top-level taxonomy branches accepted at ingest. Unknown leaf kinds are queued for review. */
export const BRAIN_TAXONOMY_BRANCHES = [
  "conversation",
  "code",
  "media",
  "document",
  "data",
  "decision",
  "task",
  "knowledge",
  "reference",
  "process",
  "workflow",
  "agent",
] as const;

/** Sentinel project_id for org-wide items. Never use NULL. */
export const ORG_LEVEL_PROJECT = "_org_level";
