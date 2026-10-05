/**
 * Promote an archive artifact into a thought. Copies the artifact's textual
 * content into a new thought with a `distilled_from` bridge edge back to the
 * source artifact. Metadata extraction runs async via the regular path.
 */

import { activeDbFor } from "../storage/active-db.js";
import { captureThought, type CaptureResult } from "./capture.js";
import type { ThoughtTypeT } from "./types.js";

export interface PromoteArtifactRequest {
  archive_hash: string;
  org_id: string;
  project_id: string;
  thought_type_hint?: ThoughtTypeT;
  relation?: string;
}

export function promoteArtifact(req: PromoteArtifactRequest): CaptureResult {
  const db = activeDbFor(req.org_id);

  const row = db
    .prepare(
      `SELECT a.hash, a.kind, a.project_id, a.org_id, a.content_type, a.content,
              (SELECT text FROM artifacts_fts_src WHERE hash = a.hash) AS text
         FROM artifacts a
        WHERE a.hash = ? AND a.org_id = ?`,
    )
    .get(req.archive_hash, req.org_id) as
    | {
        hash: string;
        kind: string;
        project_id: string;
        org_id: string;
        content_type: string | null;
        content: Buffer | null;
        text: string | null;
      }
    | undefined;

  if (!row) {
    throw new Error(`archive artifact ${req.archive_hash} not found`);
  }

  // Prefer the FTS-extracted text (already decoded); fall back to content.
  const content =
    row.text ??
    (row.content
      ? row.content.toString(
          row.content_type?.startsWith("image/") ? "base64" : "utf8",
        )
      : "");

  if (!content.trim()) {
    throw new Error(
      `archive artifact ${req.archive_hash} has no text content to promote`,
    );
  }

  return captureThought({
    content: content.slice(0, 20_000),
    org_id: req.org_id,
    project_id: req.project_id,
    source_kind: "promoted_from_archive",
    source_refs: [{ hash: row.hash, relation: req.relation ?? "distilled_from" }],
    thought_type_hint: req.thought_type_hint,
  });
}
