/**
 * Best-effort text extraction for FTS indexing. Returns NULL for kinds that
 * have no immediate textual content (media/* — Phase 5 will fill via OCR/caption).
 */

export function tryExtractText(
  kind: string,
  content: Buffer,
  contentType: string | undefined,
): string | null {
  // Media → no text until OCR/caption (Phase 5)
  if (kind.startsWith("media/")) return null;

  // Binary content types → skip
  const ct = (contentType ?? "").toLowerCase();
  if (
    ct.startsWith("image/") ||
    ct.startsWith("video/") ||
    ct.startsWith("audio/") ||
    ct === "application/octet-stream"
  ) {
    return null;
  }

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
