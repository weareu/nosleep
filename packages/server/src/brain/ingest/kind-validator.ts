import type Database from "better-sqlite3";
import { BRAIN_TAXONOMY_BRANCHES } from "../config.js";
import { isCanonicalKind } from "./canonical-kinds.js";

export class InvalidKindError extends Error {
  constructor(public kind: string, public reason: string) {
    super(`invalid kind '${kind}': ${reason}`);
    this.name = "InvalidKindError";
  }
}

/**
 * Validate a kind path. Throws InvalidKindError if the top-level branch is
 * unknown. Unknown *leaf* kinds are accepted and queued for review.
 */
export function validateKindBranch(kind: string): void {
  if (!kind.includes("/")) {
    throw new InvalidKindError(
      kind,
      "kind must be a slash-separated path with at least 2 segments",
    );
  }
  const top = kind.split("/")[0];
  if (!(BRAIN_TAXONOMY_BRANCHES as readonly string[]).includes(top)) {
    throw new InvalidKindError(
      kind,
      `unknown top-level branch '${top}' — accepted: ${BRAIN_TAXONOMY_BRANCHES.join(", ")}`,
    );
  }
}

/**
 * Track unfamiliar leaf kinds in catalog.db.kind_review_queue. Only records
 * NON-canonical kinds — canonical kinds defined in canonical-kinds.ts are
 * assumed known and never queued. Idempotent via PK.
 */
export function recordKindForReview(
  catalogDb: Database.Database,
  kind: string,
  sampleHash: string,
): void {
  if (isCanonicalKind(kind)) return;

  const existing = catalogDb
    .prepare("SELECT count FROM kind_review_queue WHERE kind = ?")
    .get(kind) as { count: number } | undefined;

  if (existing) {
    catalogDb
      .prepare(
        "UPDATE kind_review_queue SET count = count + 1 WHERE kind = ?",
      )
      .run(kind);
    return;
  }

  catalogDb
    .prepare(
      `INSERT INTO kind_review_queue (kind, first_seen_ts, sample_hash, count, resolved)
       VALUES (?, ?, ?, 1, 0)`,
    )
    .run(kind, Math.floor(Date.now() / 1000), sampleHash);
}
