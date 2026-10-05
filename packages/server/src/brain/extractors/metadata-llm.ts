/**
 * LLM metadata extractor. Classifies a captured thought (type, topics,
 * people, action items, dates) and updates thoughts.metadata_json +
 * thoughts.thought_type. The field set is inspired by the Open Brain pattern;
 * the prompt wording is NoSleep's own.
 *
 * Calls the local claude CLI in --print mode which uses the user's
 * existing Pro/Max auth — no API key needed. Times out at 30s.
 *
 * Failure is non-fatal: we log an extractor_runs row with result='failed'
 * and leave placeholder metadata in place so the thought stays FTS-searchable.
 */

import { nanoid } from "nanoid";
import type Database from "better-sqlite3";
import { activeDbFor } from "../storage/active-db.js";
import type { ThoughtTypeT } from "../thoughts/types.js";
import { canSpawnHaiku, recordHaikuSpawn } from "../haiku-budget.js";
import { headlessQuery } from "../../lib/headless-claude.js";

const EXTRACTOR_NAME = "metadata_llm";
const EXTRACTOR_VERSION = "0.1.0";
const PROMPT_VERSION = "nosleep-v2";
const MODEL = "claude-haiku-4-5";
const TIMEOUT_MS = 60_000; // 30s produced 1.7k timeouts under load — SDK boot + Haiku call needs headroom

/** Thought classification prompt. Keys must match ExtractedMetadata. */
const PROMPT_TEMPLATE = `You classify a single note that a developer saved to their knowledge base.
Read the note between the triple quotes and answer with one JSON object, nothing else.

Keys:
- "type": the best fit from "observation", "task", "idea", "reference", "person_note", "decision", "insight", "question"
- "topics": 1 to 3 short lowercase tags describing the subject (never empty)
- "people": names of people the note refers to, [] if none
- "action_items": concrete follow-ups the note implies, [] if none
- "dates_mentioned": dates the note refers to, formatted YYYY-MM-DD, [] if none

Use only what the note actually says; do not infer facts that are not written.

Note:
"""
{{CONTENT}}
"""`;

interface ExtractedMetadata {
  people: string[];
  action_items: string[];
  dates_mentioned: string[];
  topics: string[];
  type: ThoughtTypeT;
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

function normaliseExtracted(raw: unknown): ExtractedMetadata | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const type = typeof r.type === "string" ? r.type : "observation";
  const safeType = (VALID_TYPES.has(type as ThoughtTypeT) ? type : "observation") as ThoughtTypeT;
  const arr = (k: string): string[] => {
    const v = r[k];
    if (!Array.isArray(v)) return [];
    return v.filter((x) => typeof x === "string").map((x) => (x as string).slice(0, 120));
  };
  const topics = arr("topics");
  return {
    type: safeType,
    topics: topics.length > 0 ? topics.slice(0, 5) : ["uncategorized"],
    people: arr("people").slice(0, 20),
    action_items: arr("action_items").slice(0, 20),
    dates_mentioned: arr("dates_mentioned").slice(0, 20),
  };
}

function extractJsonBlock(text: string): string | null {
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(text);
  if (fenced) return fenced[1];
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return text.slice(first, last + 1);
}

async function callHaiku(content: string): Promise<ExtractedMetadata | null> {
  if (!canSpawnHaiku()) return null;
  recordHaikuSpawn();
  const prompt = PROMPT_TEMPLATE.replace("{{CONTENT}}", content.slice(0, 8000));
  try {
    const stdout = await headlessQuery({
      prompt,
      model: MODEL,
      timeoutMs: TIMEOUT_MS,
      brainInternal: true,
      purpose: "brain",
    });
    const block = extractJsonBlock(stdout);
    if (!block) return null;
    const parsed = JSON.parse(block);
    return normaliseExtracted(parsed);
  } catch {
    return null;
  }
}

export async function runMetadataExtraction(
  orgId: string,
  thoughtId: string,
): Promise<boolean> {
  const db = activeDbFor(orgId);
  const started = performance.now();

  const row = db
    .prepare(
      `SELECT id, project_id, content FROM thoughts WHERE id = ? AND org_id = ?`,
    )
    .get(thoughtId, orgId) as
    | { id: string; project_id: string; content: string }
    | undefined;

  if (!row) return false;

  const extracted = await callHaiku(row.content);
  const durationMs = performance.now() - started;

  if (!extracted) {
    recordRun(db, {
      orgId,
      projectId: row.project_id,
      thoughtId,
      durationMs,
      result: "failed",
      error: "extraction returned null",
    });
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  const metadataJson = JSON.stringify(extracted);

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE thoughts
          SET metadata_json = ?, thought_type = ?, updated_at = ?
        WHERE id = ? AND org_id = ?`,
    ).run(metadataJson, extracted.type, now, thoughtId, orgId);

    db.prepare("DELETE FROM thoughts_fts WHERE id = ?").run(thoughtId);
    db.prepare(
      `INSERT INTO thoughts_fts
       (id, project_id, thought_type, content, topics_flat, people_flat,
        actions_flat, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      thoughtId,
      row.project_id,
      extracted.type,
      row.content,
      extracted.topics.join(" "),
      extracted.people.join(" "),
      extracted.action_items.join(" "),
      now,
    );
  });
  tx();

  recordRun(db, {
    orgId,
    projectId: row.project_id,
    thoughtId,
    durationMs,
    result: "success",
  });
  return true;
}

function recordRun(
  db: Database.Database,
  args: {
    orgId: string;
    projectId: string;
    thoughtId: string;
    durationMs: number;
    result: "success" | "failed" | "skipped";
    error?: string;
  },
): void {
  try {
    db.prepare(
      `INSERT INTO extractor_runs
       (run_id, ts, extractor, extractor_version, prompt_version, model,
        artifact_hash, duration_ms, result, error,
        project_id, org_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      nanoid(),
      Math.floor(Date.now() / 1000),
      EXTRACTOR_NAME,
      EXTRACTOR_VERSION,
      PROMPT_VERSION,
      MODEL,
      args.thoughtId,
      args.durationMs,
      args.result,
      args.error ?? null,
      args.projectId,
      args.orgId,
    );
  } catch {
    /* audit writes are best-effort */
  }
}
