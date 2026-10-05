/**
 * Phase 12 — transcript ingester. Reads a Claude Code JSONL transcript
 * file (passed by the Stop hook as `transcript_path`) and emits
 * conversation/turn/user_message + conversation/turn/assistant_message
 * artifacts for every turn. Content-addressed dedup makes re-running on
 * the same transcript a no-op.
 *
 * The transcript schema follows Claude Code's session storage:
 *   {"type": "user" | "assistant", "message": {"content": "...", ...}, "uuid": "...", ...}
 * Tool calls and tool results live inside content arrays — those keep their
 * existing /api/hooks/{pre,post}-tool path and aren't re-ingested here.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingest } from "../ingest/pipeline.js";
import type { IngestRequestT } from "../ingest/types.js";

export interface TranscriptIngestRequest {
  org_id: string;
  project_id: string;
  session_id: string;
  transcript_path: string;
}

export interface TranscriptIngestResult {
  scanned: number;
  ingested: number;
  duplicates: number;
  errors: string[];
}

interface TranscriptEntry {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  uuid?: string;
  timestamp?: string;
}

/**
 * Recognise turns whose content is one of our own brain Haiku prompts —
 * those `claude --print` invocations leave a transcript behind and the
 * Stop hook would otherwise re-ingest them, causing the 2026-05-18
 * runaway-recursion incident. The hook-level env-var skip is the primary
 * defence; this is the belt-and-braces server-side filter in case a
 * spawn ever forgets to set NOSLEEP_BRAIN_INTERNAL.
 */
const BRAIN_PROMPT_PREFIXES = [
  'You triage agent/chat conversation turns into "thought-worthy"',
  "You are labelling pairs of related thoughts",
  "Extract metadata from the user's captured thought",
];
function looksLikeBrainPrompt(text: string): boolean {
  const head = text.slice(0, 200);
  for (const p of BRAIN_PROMPT_PREFIXES) {
    if (head.includes(p)) return true;
  }
  return false;
}

function extractTextContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  // Claude Code stores assistant messages as content blocks. We pull only
  // the text blocks — tool_use blocks are already captured by pre-tool
  // hooks, tool_result blocks by post-tool hooks.
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      }
    }
  }
  if (parts.length === 0) return null;
  return parts.join("\n\n");
}

export function ingestTranscript(
  req: TranscriptIngestRequest,
): TranscriptIngestResult {
  const result: TranscriptIngestResult = {
    scanned: 0,
    ingested: 0,
    duplicates: 0,
    errors: [],
  };

  if (!path.isAbsolute(req.transcript_path)) {
    result.errors.push("transcript_path must be absolute");
    return result;
  }
  if (!fs.existsSync(req.transcript_path)) {
    result.errors.push(`transcript not found: ${req.transcript_path}`);
    return result;
  }
  // Containment: this endpoint is reachable by local hooks without a key,
  // and an unconstrained path made it an arbitrary-file-read primitive
  // (read any file → retrieve via brain_search). Claude Code transcripts
  // only ever live under ~/.claude/projects — enforce that, symlink-proof.
  // NOSLEEP_TRANSCRIPT_ROOT (server env, never caller-supplied) overrides
  // for tests and non-standard installs.
  try {
    const transcriptRoot = fs.realpathSync(
      process.env.NOSLEEP_TRANSCRIPT_ROOT ??
        path.join(os.homedir(), ".claude", "projects"),
    );
    const real = fs.realpathSync(req.transcript_path);
    if (!real.startsWith(transcriptRoot + path.sep)) {
      result.errors.push(
        "transcript_path must be inside ~/.claude/projects (Claude Code transcript root)",
      );
      return result;
    }
  } catch {
    result.errors.push("transcript_path could not be resolved");
    return result;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(req.transcript_path, "utf8");
  } catch (e) {
    result.errors.push(
      `read failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return result;
  }

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  let turnOrd = 0;
  for (const line of lines) {
    result.scanned += 1;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const role = entry.message?.role ?? entry.type;
    if (role !== "user" && role !== "assistant") continue;

    const text = extractTextContent(entry.message?.content);
    if (!text || text.trim().length === 0) continue;
    if (looksLikeBrainPrompt(text)) continue;

    const ts = entry.timestamp
      ? Math.floor(new Date(entry.timestamp).getTime() / 1000)
      : undefined;

    turnOrd += 1;
    const ingestReq: IngestRequestT = {
      kind:
        role === "user"
          ? "conversation/turn/user_message"
          : "conversation/turn/assistant_message",
      content: text,
      content_type: "text/plain",
      org_id: req.org_id,
      project_id: req.project_id,
      session_id: req.session_id,
      turn_ord: turnOrd,
      ts,
      origin: {
        tool: "claude-code",
        actor: role,
      },
      kind_specific_meta: {
        transcript_uuid: entry.uuid,
      },
      schema_version: 1,
    };

    try {
      const r = ingest(ingestReq);
      if (r.duplicate) result.duplicates += 1;
      else result.ingested += 1;
    } catch (e) {
      result.errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  return result;
}
