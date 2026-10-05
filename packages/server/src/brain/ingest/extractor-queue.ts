/**
 * Extractor queue — Phase 3: metadata_llm + embedding_text run, the rest
 * are scheduled for Phase 5+. Names are persisted in ingest_events.enqueued_json
 * so later phases can reconcile (retroactively run extractors for pre-existing rows).
 */

import { getEmbedAllowlist } from "../config-store.js";

const DEFAULT_EMBED_PREFIXES = [
  "conversation/turn/",
  "code/blob",
  "code/diff",
  "knowledge/",
  "decision/",
  "document/markdown",
  "document/web_fetch",
  "document/pdf_excerpt",
  "document/text",
  "document/spec",
  "document/readme",
  "reference/link",
];

function matchesPrefix(kind: string, prefix: string): boolean {
  if (prefix.endsWith("/")) return kind.startsWith(prefix);
  return kind === prefix || kind.startsWith(prefix + "/");
}

/** Phase 3: honour per-project / per-org allowlist overrides. */
export function shouldEmbedText(
  kind: string,
  scope?: { orgId: string; projectId: string },
): boolean {
  const list =
    scope && getEmbedAllowlist(scope.orgId, scope.projectId)
      ? (getEmbedAllowlist(scope.orgId, scope.projectId) as string[])
      : DEFAULT_EMBED_PREFIXES;
  return list.some((p) => matchesPrefix(kind, p));
}

/** Map a kind path to the set of extractors that would run. */
export function extractorsForKind(kind: string): string[] {
  const out: string[] = [];

  // Embedding allowlist (Phase 3 will actually run)
  if (
    kind.startsWith("conversation/turn/") ||
    kind.startsWith("code/blob") ||
    kind === "code/diff" ||
    kind.startsWith("knowledge/") ||
    kind.startsWith("decision/") ||
    kind === "document/markdown" ||
    kind === "document/web_fetch" ||
    kind === "document/pdf_excerpt" ||
    kind === "document/text" ||
    kind === "document/spec" ||
    kind === "document/readme" ||
    kind === "reference/link"
  ) {
    out.push("embedding_text");
  }

  // Image extractors (Phase 5)
  if (kind.startsWith("media/image/")) {
    out.push("phash", "clip", "exif", "scene_classify", "caption");
    if (
      kind === "media/image/screenshot" ||
      kind === "media/image/terminal_capture" ||
      kind === "media/image/diagram"
    ) {
      out.push("ocr");
    }
  }

  // Code AST (Phase 5)
  if (kind.startsWith("code/blob") || kind === "code/file_snapshot") {
    out.push("ast");
  }

  // Metadata LLM (Phase 2) — runs on thoughts and some archive kinds
  if (
    kind.startsWith("conversation/turn/user_message") ||
    kind.startsWith("conversation/turn/assistant_message") ||
    kind.startsWith("knowledge/") ||
    kind.startsWith("decision/")
  ) {
    out.push("metadata_llm");
  }

  // Phase 11 — auto-thought extractor: lift insights from user/assistant
  // turns into the thought layer (linked back to the source artifact).
  if (kind.startsWith("conversation/turn/")) {
    out.push("auto_thought");
  }

  return out;
}
