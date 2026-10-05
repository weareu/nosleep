/**
 * Best-effort text extraction for FTS indexing. Returns NULL for kinds that
 * have no immediate textual content (media/* — Phase 5 will fill via OCR/caption)
 * and for binary payloads (PDF bytes are indexed per page by pdf-handler).
 */

import { isBinaryContentType } from "./hash.js";

export function tryExtractText(
  kind: string,
  content: Buffer,
  contentType: string | undefined,
): string | null {
  // Media → no text until OCR/caption (Phase 5)
  if (kind.startsWith("media/")) return null;

  // Binary content types → skip
  if (isBinaryContentType(contentType)) return null;

  // Everything else: decode as utf-8
  try {
    const text = content.toString("utf8");
    // Strip obvious non-text bytes
    if (text.length === 0) return null;
    return text;
  } catch {
    return null;
  }
}
