/**
 * Session hooks → document artifacts. When an agent (Claude Code / OpenCode
 * via the post-tool hook) Reads a document, ingest the FILE from disk through
 * the same upload path (ingestFile): PDFs get per-page searchable text,
 * markdown/text become document/* artifacts.
 *
 * Why from disk: the hook's tool_response is truncated to 64 KB and, for
 * PDFs, carries base64 page images — not the document. The hook endpoints
 * are loopback-only, so the server reading a local path the agent just read
 * exposes nothing new. Bounded by BRAIN_INGEST_MAX_BYTES; never throws.
 *
 * Not distilled into thoughts (agents Read many files — LLM budget); the
 * documents are archived, FTS-indexed and embedded.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";
import { BRAIN_INGEST_MAX_BYTES } from "../config.js";
import { ingestFile, type FileIngestResult } from "../ingest/file-ingest.js";

const HOOK_DOCUMENT_EXTS = new Set(["pdf", "md", "markdown", "txt", "text"]);

export function isHookDocumentPath(filePath: string): boolean {
  if (!filePath) return false;
  return HOOK_DOCUMENT_EXTS.has(path.extname(filePath).slice(1).toLowerCase());
}

export interface ReadDocumentHook {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  orgId?: string;
  projectId?: string;
  sessionId?: string;
  toolVersion?: string;
  /** Agent that performed the Read (origin.tool). Default "claude-code". */
  agent?: string;
}

export async function ingestReadDocument(
  p: ReadDocumentHook,
  log: (msg: string, ctx: Record<string, unknown>) => void,
): Promise<FileIngestResult | null> {
  if (p.toolName !== "Read" || !p.orgId || !p.projectId) return null;
  const filePath = typeof p.toolInput?.file_path === "string" ? p.toolInput.file_path : "";
  if (!isHookDocumentPath(filePath) || !path.isAbsolute(filePath)) return null;
  const ctx = { file_path: filePath, org_id: p.orgId, project_id: p.projectId, session_id: p.sessionId };
  try {
    const st = await fsp.stat(filePath);
    if (!st.isFile()) return null;
    if (st.size > BRAIN_INGEST_MAX_BYTES) {
      log("hook document skipped: over size cap", { ...ctx, size: st.size, max: BRAIN_INGEST_MAX_BYTES });
      return null;
    }
    const bytes = await fsp.readFile(filePath);
    return await ingestFile({
      filename: filePath,
      bytes,
      org_id: p.orgId,
      project_id: p.projectId,
      session_id: p.sessionId,
      origin: { tool: p.agent ?? "claude-code", version: p.toolVersion, actor: "read_hook" },
      distill: false,
      onWarn: (msg, err) => log(msg, { ...ctx, err: err instanceof Error ? err.message : String(err) }),
    });
  } catch (err) {
    log("hook document ingest failed", { ...ctx, err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
