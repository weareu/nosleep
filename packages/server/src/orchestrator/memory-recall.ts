/**
 * Recall-on-launch (Memory v2, slice 1).
 *
 * NoSleep captured 48k distilled thoughts + a curated memory table, but
 * NOTHING ever read them at work time (memory.access_count was 0 org-wide) —
 * capture without recall. This module builds a "## Relevant memory" block for
 * a session's goal prompt from the two durable tiers:
 *   - procedural: the org's memory table (skills/decisions/patterns/facts)
 *   - semantic:   brain thoughts matched to the goal text (FTS, per keyword)
 * Injection bumps memory.access_count, turning importance into a real,
 * measurable signal (and the consolidation slice will weight by it).
 *
 * Fail-open by design: recall must NEVER block or fail a launch — any error
 * returns null and the session starts without the block.
 */

import type Database from "better-sqlite3";
import { searchThoughts } from "../brain/thoughts/search.js";

const MAX_MEMORY_ROWS = 3;
const MAX_THOUGHTS = 5;
const MAX_KEYWORDS = 6;
const SNIPPET = 220;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "them",
  "then", "than", "when", "will", "must", "should", "task", "tasks", "work",
  "complete", "completion", "following", "project", "continue", "autonomous",
  "loop", "next", "below", "strategy", "tree", "acceptance", "criteria",
]);

/** Top distinct significant words from the goal text. */
export function extractKeywords(text: string, max = MAX_KEYWORDS): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

export interface RecallInput {
  readonly mainDb: Database.Database;
  readonly orgId: string;
  readonly projectId: string;
  readonly goalText: string;
}

/**
 * Build the recall block, or null when nothing relevant exists.
 * Bumps access_count on every memory row it injects.
 */
export function buildRecallBlock(input: RecallInput): string | null {
  const sections: string[] = [];

  // Procedural tier — org memory (org-wide + this project's rows).
  try {
    const rows = input.mainDb
      .prepare(
        `SELECT id, category, key, value FROM memory
         WHERE org_id = ? AND (project_id IS NULL OR project_id = ?)
         ORDER BY access_count DESC, updated_at DESC LIMIT ?`,
      )
      .all(input.orgId, input.projectId, MAX_MEMORY_ROWS) as Array<{ id: string; category: string; key: string; value: string }>;
    if (rows.length > 0) {
      const ph = rows.map(() => "?").join(",");
      input.mainDb
        .prepare(`UPDATE memory SET access_count = access_count + 1 WHERE id IN (${ph})`)
        .run(...rows.map((r) => r.id));
      sections.push(
        rows.map((r) => `- [${r.category}] ${r.key}: ${r.value.slice(0, SNIPPET)}`).join("\n"),
      );
    }
  } catch {
    /* fail-open */
  }

  // Semantic tier — thoughts matched per goal keyword (searchThoughts
  // phrase-escapes its query, so multi-word goal text must be split).
  try {
    const keywords = extractKeywords(input.goalText);
    if (keywords.length > 0) {
      const seen = new Set<string>();
      const hits: Array<{ id: string; content: string; relevance: number }> = [];
      for (const kw of keywords) {
        for (const r of searchThoughts({ orgId: input.orgId, projectId: input.projectId, query: kw, scope: "project", limit: 2 })) {
          if (seen.has(r.thought.id)) continue;
          seen.add(r.thought.id);
          hits.push({ id: r.thought.id, content: r.thought.content, relevance: r.relevance });
        }
      }
      hits.sort((a, b) => b.relevance - a.relevance);
      if (hits.length > 0) {
        sections.push(
          hits
            .slice(0, MAX_THOUGHTS)
            .map((h) => `- ${h.content.slice(0, SNIPPET)} (thought:${h.id})`)
            .join("\n"),
        );
      }
    }
  } catch {
    /* fail-open — brain DB may be unavailable; launch proceeds without */
  }

  if (sections.length === 0) return null;
  return [
    "## Relevant memory (auto-recall)",
    "Prior knowledge that may apply — verify against current code before relying on it:",
    ...sections,
  ].join("\n");
}
