/**
 * Agent-side file → brain upload payload. Used by the two MCP surfaces that
 * expose "ingest a local file into the brain" (mcp-brain `ingest_file`,
 * mcp-gateway `brain_ingest_file`); both then POST the payload to the ONE
 * upload route, POST /api/brain/ingest/file — the same path web upload uses.
 *
 * Node-only (fs). Deliberately NOT re-exported from the package index, which
 * the web bundle imports. Import it as "@nosleep/shared/dist/brain-file.js".
 *
 * Safety: an agent-supplied path must resolve (after symlinks) INSIDE the
 * project's directory, and no path segment may be a dotfile/dot-directory
 * (.env, .git, .ssh, …) — a prompt-injected agent cannot exfiltrate secrets
 * or files from elsewhere on the machine into the brain.
 */

import fs from "node:fs";
import path from "node:path";

/** Decoded upload cap — mirrors the server's BRAIN_INGEST_MAX_BYTES (10 MB). */
export const BRAIN_FILE_MAX_BYTES = 10 * 1024 * 1024;

export class BrainFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrainFileError";
  }
}

export interface BrainFilePayload {
  readonly filename: string;
  readonly content_base64: string;
  readonly content_type?: string;
}

export interface BrainFileSource {
  /** Local path (absolute, or relative to projectRoot). */
  readonly path?: string;
  /** Inline content instead of a path. Requires `filename`. */
  readonly contentBase64?: string;
  /** Overrides the basename (required with contentBase64). */
  readonly filename?: string;
  readonly contentType?: string;
  /** The project's registered directory — paths must stay inside it. */
  readonly projectRoot?: string | null;
}

function decodedBase64Length(b64: string): number {
  const clean = b64.replace(/\s+/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
}

/** Resolve + validate an agent-supplied path against the project root. */
export function resolveProjectFile(projectRoot: string, filePath: string): string {
  let root: string;
  try {
    root = fs.realpathSync(path.resolve(projectRoot));
  } catch {
    throw new BrainFileError(`project directory not found: ${projectRoot}`);
  }
  const candidate = path.resolve(root, filePath);
  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    throw new BrainFileError(`file not found: ${filePath}`);
  }
  const rel = path.relative(root, real);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new BrainFileError(`path is outside the project directory (${root}): ${filePath}`);
  }
  if (rel.split(path.sep).some((seg) => seg.startsWith("."))) {
    throw new BrainFileError(`refusing to ingest a dotfile / hidden path: ${rel}`);
  }
  return real;
}

/** Build the POST /api/brain/ingest/file payload (minus org/project ids). */
export function readBrainFilePayload(src: BrainFileSource): BrainFilePayload {
  if (src.contentBase64 !== undefined) {
    if (!src.filename) throw new BrainFileError("filename is required with content_base64");
    if (decodedBase64Length(src.contentBase64) > BRAIN_FILE_MAX_BYTES) {
      throw new BrainFileError(`file exceeds the ${BRAIN_FILE_MAX_BYTES / 1024 / 1024} MB upload limit`);
    }
    return { filename: src.filename, content_base64: src.contentBase64, content_type: src.contentType };
  }
  if (!src.path) throw new BrainFileError("pass either path or content_base64 + filename");
  if (!src.projectRoot) {
    throw new BrainFileError("project has no local directory; pass content_base64 + filename instead");
  }
  const abs = resolveProjectFile(src.projectRoot, src.path);
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new BrainFileError(`not a regular file: ${src.path}`);
  if (stat.size > BRAIN_FILE_MAX_BYTES) {
    throw new BrainFileError(
      `file is ${(stat.size / 1024 / 1024).toFixed(1)} MB; the upload limit is ${BRAIN_FILE_MAX_BYTES / 1024 / 1024} MB`,
    );
  }
  return {
    filename: src.filename ?? path.basename(abs),
    content_base64: fs.readFileSync(abs).toString("base64"),
    content_type: src.contentType,
  };
}
