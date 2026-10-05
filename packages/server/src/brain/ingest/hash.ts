import { createHash } from "node:crypto";

/** SHA-256 hex of a buffer or string. */
export function sha256hex(input: Buffer | string): string {
  const h = createHash("sha256");
  h.update(input);
  return h.digest("hex");
}

/** Lower-cased media type without parameters ("Text/Plain; charset=x" → "text/plain"). */
export function normalizeContentType(contentType: string | undefined | null): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase();
}

/**
 * Content types whose wire form is base64 and whose stored bytes are not
 * UTF-8 text. Single source of truth for ingest decoding, FTS extraction and
 * the artifact read path.
 */
export function isBinaryContentType(contentType: string | undefined | null): boolean {
  const ct = normalizeContentType(contentType);
  return (
    ct.startsWith("image/") ||
    ct.startsWith("video/") ||
    ct.startsWith("audio/") ||
    ct === "application/octet-stream" ||
    ct === "application/pdf"
  );
}

/** Convert base64-or-text input to a Buffer for hashing + storage. */
export function toBuffer(
  content: string,
  contentType: string | undefined,
): Buffer {
  if (isBinaryContentType(contentType)) {
    return Buffer.from(content, "base64");
  }
  return Buffer.from(content, "utf8");
}
