import { createHash } from "node:crypto";

/** SHA-256 hex of a buffer or string. */
export function sha256hex(input: Buffer | string): string {
  const h = createHash("sha256");
  h.update(input);
  return h.digest("hex");
}

/** Convert base64-or-text input to a Buffer for hashing + storage. */
export function toBuffer(
  content: string,
  contentType: string | undefined,
): Buffer {
  const ct = (contentType ?? "").toLowerCase();
  const isBinary =
    ct.startsWith("image/") ||
    ct.startsWith("video/") ||
    ct.startsWith("audio/") ||
    ct === "application/octet-stream";
  if (isBinary) {
    return Buffer.from(content, "base64");
  }
  return Buffer.from(content, "utf8");
}
