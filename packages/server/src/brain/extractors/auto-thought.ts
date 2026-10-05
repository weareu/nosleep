/**
 * Phase 11 — auto-thought extractor.
 *
 * Runs on conversation/turn/{user,assistant} artifacts. Asks Haiku to decide
 * whether the turn contains a thought worth lifting (decision/insight/
 * observation/question/task/idea) — and if yes, returns the distilled core.
 * Routine turns ("I edited the file", short tool acks, plain "ok") return
 * null and never become thoughts.
 *
 * On a yes:
 *   1. INSERT INTO thoughts (with source_kind='auto_from_artifact')
 *   2. INSERT INTO thought_archive_refs linking back to the source hash
 *   3. Schedule embedding for the new thought (via existing pipeline)
 *
 * Idempotent — re-running on the same artifact dedupes via a hash check
 * (artifact_hash + auto_thought source_kind). Failure is non-fatal: the
 * artifact remains in the archive, just unlifted.
 */

import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import type Database from "better-sqlite3";
import { activeDbFor } from "../storage/active-db.js";
import { initialMetadata, type ThoughtTypeT } from "../thoughts/types.js";
import { canSpawnHaiku, recordHaikuSpawn } from "../haiku-budget.js";
import { headlessQuery, resolveLlmRoute } from "../../lib/headless-claude.js";

const MODEL = "claude-haiku-4-5";
const TIMEOUT_MS = 60_000; // 30s produced 1.7k timeouts under load — SDK boot + Haiku call needs headroom
const MIN_CONTENT_LEN = 60;
const MAX_CONTENT_LEN = 8_000;

const PROMPT = `You triage agent/chat conversation turns into "thought-worthy" or "skip".

A thought-worthy turn distils a decision, insight, observation, question, idea, or task — something a future you would want to recall. NOT thought-worthy: routine tool acks, "ok", "done", file diffs without commentary, plain repetitions of code/output.

Return ONLY a single JSON object on one line, no commentary:

If thought-worthy:
  {"keep": true, "type": "<observation|task|idea|reference|person_note|decision|insight|question>", "content": "<one or two sentence distillation, max 240 chars>"}

If not:
  {"keep": false}

Turn:
"""
{{CONTENT}}
"""`;

/**
 * User-captured documents (uploads, URL captures) are distilled too. One
 * thought per document: a PDF is distilled from its source artifact with the
 * page texts concatenated, never page-by-page (budget).
 */
export const DISTILLABLE_DOCUMENT_KINDS: ReadonlySet<string> = new Set([
  "document/markdown",
  "document/text",
  "document/web_fetch",
  "document/pdf",
]);

const DOC_PROMPT = `You distil a document a user saved into their knowledge base.

Decide whether it holds something a future reader would want to recall — a decision, insight, observation, reference, idea, task or question. Boilerplate, navigation chrome, empty templates and pure data dumps are NOT worth keeping.

Return ONLY a single JSON object on one line, no commentary:

If worth keeping:
  {"keep": true, "type": "<observation|task|idea|reference|person_note|decision|insight|question>", "content": "<one or two sentence distillation of the document's key point, max 240 chars>"}

If not:
  {"keep": false}

Document:
"""
{{CONTENT}}
"""`;

interface ExtractedThought {
  keep: true;
  type: ThoughtTypeT;
  content: string;
}

interface SkippedThought {
  keep: false;
}

const VALID_TYPES = new Set<ThoughtTypeT>([
  "observation",
  "task",
  "idea",
  "reference",
  "person_note",
  "decision",
  "insight",
  "question",
]);

interface AutoThoughtOptions {
  org_id: string;
  artifact_hash: string;
  /** Skip the LLM call — used by tests; returns null. */
  dry_run?: boolean;
}

interface AutoThoughtResult {
  thought_id: string | null;
  skipped_reason: string | null;
  duration_ms: number;
}

/** Phase 12 — write a row to extractor_runs so the auto-thought
 *  extractor is visible on the admin health dashboard. Best-effort. */
function modelLabel(): string {
  try {
    const r = resolveLlmRoute("brain");
    return r.provider === "openai" ? `openai:${r.model}` : MODEL;
  } catch {
    return MODEL;
  }
}

function recordRun(
  db: Database.Database,
  args: {
    artifact_hash: string;
    org_id: string;
    project_id: string;
    duration_ms: number;
    result: "success" | "skipped" | "failed";
    skipped_reason: string | null;
  },
): void {
  try {
    db.prepare(
      `INSERT INTO extractor_runs
       (run_id, ts, extractor, extractor_version, prompt_version, model,
        artifact_hash, duration_ms, result, error,
        project_id, org_id)
       VALUES (?, ?, 'auto_thought', '0.2.0', 'phase11-v1', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      nanoid(),
      Math.floor(Date.now() / 1000),
      modelLabel(),
      args.artifact_hash,
      args.duration_ms,
      args.result,
      args.skipped_reason,
      args.project_id,
      args.org_id,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[auto-thought] extractor_runs insert failed for ${args.artifact_hash}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function runAutoThoughtExtraction(
  opts: AutoThoughtOptions,
): Promise<AutoThoughtResult> {
  const started = performance.now();
  const db = activeDbFor(opts.org_id);

  const artifact = db
    .prepare(
      `SELECT a.hash, a.kind, a.content, a.org_id, a.project_id, a.session_id, a.actor
         FROM artifacts a
        WHERE a.hash = ? AND a.org_id = ?`,
    )
    .get(opts.artifact_hash, opts.org_id) as
    | {
        hash: string;
        kind: string;
        content: Buffer | null;
        org_id: string;
        project_id: string;
        session_id: string | null;
        actor: string | null;
      }
    | undefined;

  if (!artifact) {
    return { thought_id: null, skipped_reason: "artifact_not_found", duration_ms: 0 };
  }
  const isDocument = DISTILLABLE_DOCUMENT_KINDS.has(artifact.kind);
  if (!artifact.kind.startsWith("conversation/turn/") && !isDocument) {
    return { thought_id: null, skipped_reason: "wrong_kind", duration_ms: 0 };
  }
  // Documents get an extractor_runs row for every outcome so a missing
  // thought is diagnosable; conversation turns keep the success-only volume.
  const finish = (
    skipped_reason: string,
    result: "skipped" | "failed" = "skipped",
  ): AutoThoughtResult => {
    const out = { thought_id: null, skipped_reason, duration_ms: performance.now() - started };
    if (isDocument) {
      recordRun(db, {
        artifact_hash: artifact.hash,
        org_id: artifact.org_id,
        project_id: artifact.project_id,
        duration_ms: out.duration_ms,
        result,
        skipped_reason,
      });
    }
    return out;
  };

  // Idempotency layer 1: skip if a thought already exists for this exact
  // artifact hash.
  const existing = db
    .prepare(
      `SELECT t.id FROM thoughts t
         JOIN thought_archive_refs r ON r.thought_id = t.id
        WHERE r.archive_hash = ? AND t.source_kind = 'auto_from_artifact'
        LIMIT 1`,
    )
    .get(opts.artifact_hash) as { id: string } | undefined;
  if (existing) {
    return {
      thought_id: existing.id,
      skipped_reason: "already_extracted",
      duration_ms: performance.now() - started,
    };
  }

  const text =
    artifact.kind === "document/pdf"
      ? pdfPagesText(db, artifact.hash)
      : decodeContent(artifact.content);
  if (!text || text.trim().length < MIN_CONTENT_LEN) {
    return finish("too_short");
  }

  // Idempotency layer 2: normalised-content fingerprint. Stops attackers
  // (or noisy hooks) from re-paying Haiku tokens by appending whitespace /
  // case / zero-width chars to produce a "new" artifact hash.
  const fingerprint = normalisedFingerprint(text);
  const fpHit = db
    .prepare(
      `SELECT t.id FROM thoughts t
        WHERE t.org_id = ? AND t.project_id = ?
          AND t.source_kind = 'auto_from_artifact'
          AND substr(t.metadata_json, 1, 80) LIKE ?
        LIMIT 1`,
    )
    .get(
      artifact.org_id,
      artifact.project_id,
      `%"_fp":"${fingerprint}"%`,
    ) as { id: string } | undefined;
  if (fpHit) {
    return {
      thought_id: fpHit.id,
      skipped_reason: "already_extracted_fp",
      duration_ms: performance.now() - started,
    };
  }

  if (opts.dry_run) {
    return {
      thought_id: null,
      skipped_reason: "dry_run",
      duration_ms: performance.now() - started,
    };
  }

  const verdict = await callHaiku(text, isDocument ? DOC_PROMPT : PROMPT);
  if (!verdict) {
    return finish("llm_failed", "failed");
  }
  if (verdict.keep === false) {
    return finish("not_thought_worthy");
  }

  const thoughtId = insertThought(db, {
    org_id: artifact.org_id,
    project_id: artifact.project_id,
    content: verdict.content.slice(0, 240),
    type: verdict.type,
    source_artifact_hash: artifact.hash,
    fingerprint,
  });

  const finalResult: AutoThoughtResult = {
    thought_id: thoughtId,
    skipped_reason: null,
    duration_ms: performance.now() - started,
  };
  recordRun(db, {
    artifact_hash: artifact.hash,
    org_id: artifact.org_id,
    project_id: artifact.project_id,
    duration_ms: finalResult.duration_ms,
    result: "success",
    skipped_reason: null,
  });
  return finalResult;
}

/** Page texts of an ingested PDF (document/pdf_excerpt rows linked by
 *  page_of_document), in page order, capped at MAX_CONTENT_LEN. */
function pdfPagesText(db: Database.Database, sourceHash: string): string | null {
  const rows = db
    .prepare(
      `SELECT a.content AS content
         FROM artifact_edges e
         JOIN artifacts a ON a.hash = e.from_hash
        WHERE e.to_hash = ? AND e.relation = 'page_of_document'
        ORDER BY CAST(json_extract(a.kind_specific_meta, '$.page_number') AS INTEGER)`,
    )
    .all(sourceHash) as Array<{ content: Buffer | null }>;
  const text = rows
    .map((r) => (r.content ? r.content.toString("utf8") : ""))
    .filter(Boolean)
    .join("\n\n");
  return text ? text.slice(0, MAX_CONTENT_LEN) : null;
}

function decodeContent(content: Buffer | null): string | null {
  if (!content) return null;
  try {
    return content.toString("utf8").slice(0, MAX_CONTENT_LEN);
  } catch {
    return null;
  }
}

// Test hook: lets vitest bypass the real Haiku CLI.
let extractorOverride:
  | ((content: string) => Promise<ExtractedThought | SkippedThought | null>)
  | null = null;
export function __setAutoThoughtHook(
  fn:
    | ((content: string) => Promise<ExtractedThought | SkippedThought | null>)
    | null,
): void {
  extractorOverride = fn;
}

/**
 * Defang the closing fence so attacker-controlled content can't break out
 * of the prompt template and steer Haiku into emitting a forged verdict.
 * Replaces triple-quotes / triple-backticks with a visually similar
 * unicode equivalent before interpolation.
 */
function defangPromptDelimiters(s: string): string {
  return s
    .replace(/"""/g, "”””")
    .replace(/```/g, "ʼʼʼ")
    .replace(/<<<USER/g, "<​USER")
    .replace(/USER>>>/g, "USER>​");
}

async function callHaiku(
  content: string,
  template: string,
): Promise<ExtractedThought | SkippedThought | null> {
  if (extractorOverride) return extractorOverride(content);
  if (!canSpawnHaiku()) {
    // Kill switch or rate-limit. See haiku-budget + incident 2026-05-18.
    return null;
  }
  recordHaikuSpawn();
  const safeContent = defangPromptDelimiters(content);
  const prompt = template.replace("{{CONTENT}}", safeContent);
  try {
    // brainInternal tags the run so nosleep hooks skip ingesting it —
    // otherwise the hooks ingest our triage prompt back as a "turn",
    // auto-thought re-triages it, and we get the 800K-token recursion that
    // nuked the user's account on 2026-05-18.
    const stdout = await headlessQuery({
      prompt,
      model: MODEL,
      timeoutMs: TIMEOUT_MS,
      brainInternal: true,
      purpose: "brain",
    });
    const verdict = parseVerdict(stdout);
    if (!verdict && stdout) {
      // Make rejections (bad model name, auth issue, etc.) visible.
      // Previously these silently returned null and 0 thoughts ever
      // landed — that's how the haiku-4.5 bug went undetected.
      // eslint-disable-next-line no-console
      console.error(
        `[auto-thought] unparseable verdict. output=${stdout.slice(0, 200)}`,
      );
    }
    return verdict;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[auto-thought] CLI invocation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function parseVerdict(text: string): ExtractedThought | SkippedThought | null {
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(text);
  let raw = fenced ? fenced[1] : null;
  if (!raw) {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first === -1 || last === -1 || last <= first) return null;
    raw = text.slice(first, last + 1);
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.keep === false) return { keep: false };
    if (parsed.keep !== true) return null;
    const type = typeof parsed.type === "string" ? parsed.type : "observation";
    const safeType = (
      VALID_TYPES.has(type as ThoughtTypeT) ? type : "observation"
    ) as ThoughtTypeT;
    const c = typeof parsed.content === "string" ? parsed.content.trim() : "";
    if (!c) return null;
    return { keep: true, type: safeType, content: c };
  } catch {
    return null;
  }
}

interface InsertArgs {
  org_id: string;
  project_id: string;
  content: string;
  type: ThoughtTypeT;
  source_artifact_hash: string;
  /** Normalised-content fingerprint — stamped on metadata for idempotency. */
  fingerprint: string;
}

/**
 * Normalised-content fingerprint. Collapses whitespace + lowercases +
 * strips zero-width chars + control chars, then SHA-256s the first 4 KiB.
 * Used as a secondary dedup key on auto-extracted thoughts so callers
 * can't bypass idempotency by re-ingesting whitespace-noised artifacts.
 */
function normalisedFingerprint(text: string): string {
  const normalised = text
    .normalize("NFKC")
    .replace(/[​-‍﻿]/g, "")
    .replace(/[ -]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 4096);
  return createHash("sha256").update(normalised).digest("hex").slice(0, 16);
}

function insertThought(db: Database.Database, args: InsertArgs): string {
  const id = nanoid();
  const now = Math.floor(Date.now() / 1000);
  const meta: Record<string, unknown> = {
    ...initialMetadata(args.type),
    _fp: args.fingerprint,
  };

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO thoughts
       (id, org_id, project_id, content, metadata_json, thought_type,
        source_kind, source_refs_json, strategy_node_ref,
        created_at, updated_at, visibility)
       VALUES (?, ?, ?, ?, ?, ?, 'auto_from_artifact', ?, NULL, ?, ?, 'active')`,
    ).run(
      id,
      args.org_id,
      args.project_id,
      args.content,
      JSON.stringify(meta),
      args.type,
      JSON.stringify([
        { hash: args.source_artifact_hash, relation: "supports" },
      ]),
      now,
      now,
    );

    db.prepare(
      `INSERT INTO thought_archive_refs
       (thought_id, archive_hash, relation, project_id, created_at)
       VALUES (?, ?, 'supports', ?, ?)`,
    ).run(id, args.source_artifact_hash, args.project_id, now);

    db.prepare(
      `INSERT INTO thoughts_fts
       (id, project_id, thought_type, content, topics_flat, people_flat,
        actions_flat, created_at)
       VALUES (?, ?, ?, ?, '', '', '', ?)`,
    ).run(id, args.project_id, args.type, args.content, now);
  });
  tx();

  return id;
}
