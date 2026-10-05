/**
 * Phase 10 — LLM-suggested thought_refs proposer.
 *
 * Scans thought pairs whose content-embedding cosine similarity is above
 * a floor, batches them through Haiku to label the relation, and stores
 * proposals in thought_ref_suggestions for human review. Never inserts
 * directly into thought_refs — approval happens via the admin UI.
 */

import { nanoid } from "nanoid";
import type Database from "better-sqlite3";
import { activeDbFor } from "../storage/active-db.js";
import { isVecLoaded } from "../storage/vec-loader.js";
import { canSpawnHaiku, recordHaikuSpawn } from "../haiku-budget.js";
import { headlessQuery } from "../../lib/headless-claude.js";

const MODEL = "claude-haiku-4-5";
const TIMEOUT_MS = 60_000; // 30s produced 1.7k timeouts under load — SDK boot + Haiku call needs headroom
const COSINE_FLOOR = 0.8;
const PAIRS_PER_BATCH = 20;

const VALID_RELATIONS = new Set<string>([
  "refines",
  "supersedes",
  "contradicts",
  "duplicate_of",
  "related_to",
  "null",
]);

const PROMPT_PREAMBLE = `You are labelling pairs of related thoughts. For each pair return a relation
from this fixed set:
  refines       — thought B narrows or specialises A
  supersedes    — B replaces A
  contradicts   — B disagrees with A
  duplicate_of  — B and A say the same thing
  related_to    — both touch the same topic but no stronger relation
  null          — no meaningful relation

For each pair return a JSON object: {"i": <index>, "relation": "...", "justification": "<one sentence>"}
Return ONLY a JSON array of these objects, no commentary.`;

interface ThoughtRow {
  id: string;
  content: string;
  thought_type: string | null;
  project_id: string;
}

interface CandidatePair {
  index: number;
  a: ThoughtRow;
  b: ThoughtRow;
  cosine: number;
}

interface ProposerResult {
  pairs_examined: number;
  suggestions_created: number;
  batches_run: number;
  duration_ms: number;
  skipped_reason: string | null;
}

export interface ProposerOptions {
  org_id: string;
  project_id: string;
  max_pairs?: number;
  cosine_floor?: number;
  dry_run?: boolean;
}

export async function runThoughtRefProposer(
  opts: ProposerOptions,
): Promise<ProposerResult> {
  const started = performance.now();
  const db = activeDbFor(opts.org_id);
  const cosineFloor = opts.cosine_floor ?? COSINE_FLOOR;
  const maxPairs = opts.max_pairs ?? 200;

  if (!isVecLoaded(db)) {
    return {
      pairs_examined: 0,
      suggestions_created: 0,
      batches_run: 0,
      duration_ms: performance.now() - started,
      skipped_reason: "vec_unavailable",
    };
  }

  const pairs = collectCandidatePairs(db, opts.project_id, cosineFloor, maxPairs);
  if (pairs.length === 0) {
    return {
      pairs_examined: 0,
      suggestions_created: 0,
      batches_run: 0,
      duration_ms: performance.now() - started,
      skipped_reason: "no_candidates",
    };
  }

  if (opts.dry_run) {
    return {
      pairs_examined: pairs.length,
      suggestions_created: 0,
      batches_run: 0,
      duration_ms: performance.now() - started,
      skipped_reason: "dry_run",
    };
  }

  let suggestionsCreated = 0;
  let batchesRun = 0;

  for (let i = 0; i < pairs.length; i += PAIRS_PER_BATCH) {
    const batch = pairs.slice(i, i + PAIRS_PER_BATCH);
    const labels = await callHaikuBatch(batch);
    batchesRun += 1;
    if (!labels) continue;

    for (const label of labels) {
      if (label.index < 0 || label.index >= batch.length) continue;
      if (label.relation === "null") continue;
      if (!VALID_RELATIONS.has(label.relation)) continue;
      const pair = batch[label.index];
      const inserted = insertSuggestion(db, {
        org_id: opts.org_id,
        project_id: opts.project_id,
        from: pair.a.id,
        to: pair.b.id,
        relation: label.relation,
        justification: label.justification,
        cosine: pair.cosine,
      });
      if (inserted) suggestionsCreated += 1;
    }
  }

  return {
    pairs_examined: pairs.length,
    suggestions_created: suggestionsCreated,
    batches_run: batchesRun,
    duration_ms: performance.now() - started,
    skipped_reason: null,
  };
}

function collectCandidatePairs(
  db: Database.Database,
  projectId: string,
  cosineFloor: number,
  maxPairs: number,
): CandidatePair[] {
  const thoughts = db
    .prepare(
      `SELECT id, content, thought_type, project_id, created_at
         FROM thoughts
        WHERE project_id = ? AND visibility = 'active'
        ORDER BY created_at ASC`,
    )
    .all(projectId) as Array<ThoughtRow & { created_at: number }>;

  if (thoughts.length < 2) return [];

  const byId = new Map(thoughts.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const pairs: CandidatePair[] = [];

  for (const t of thoughts) {
    if (pairs.length >= maxPairs) break;
    const neighbours = nearestThoughtNeighbours(
      db,
      t.id,
      projectId,
      cosineFloor,
      8,
    );
    for (const n of neighbours) {
      if (n.id === t.id) continue;
      const fromId = t.id < n.id ? t.id : n.id;
      const toId = t.id < n.id ? n.id : t.id;
      const key = fromId + "|" + toId;
      if (seen.has(key)) continue;
      seen.add(key);

      const existingRef = db
        .prepare(
          `SELECT 1 FROM thought_refs
            WHERE (from_thought_id = ? AND to_thought_id = ?)
               OR (from_thought_id = ? AND to_thought_id = ?)`,
        )
        .get(fromId, toId, toId, fromId);
      if (existingRef) continue;

      const existingSug = db
        .prepare(
          `SELECT 1 FROM thought_ref_suggestions
            WHERE from_thought_id = ? AND to_thought_id = ?`,
        )
        .get(fromId, toId);
      if (existingSug) continue;

      const a = byId.get(fromId);
      const b = byId.get(toId);
      if (!a || !b) continue;

      pairs.push({ index: pairs.length, a, b, cosine: n.cosine });
      if (pairs.length >= maxPairs) break;
    }
  }

  return pairs;
}

function nearestThoughtNeighbours(
  db: Database.Database,
  thoughtId: string,
  projectId: string,
  cosineFloor: number,
  k: number,
): Array<{ id: string; cosine: number }> {
  const src = db
    .prepare(
      `SELECT v.embedding FROM vec_text v
         JOIN vec_text_map m ON m.rowid = v.rowid
        WHERE m.hash = ? AND m.referrer_kind = 'thought'
        LIMIT 1`,
    )
    .get(thoughtId) as { embedding: Buffer } | undefined;
  if (!src) return [];

  try {
    const rows = db
      .prepare(
        `SELECT m.hash AS id, v.distance AS distance
           FROM vec_text v
           JOIN vec_text_map m ON m.rowid = v.rowid
          WHERE v.embedding MATCH ?
            AND k = ?
            AND m.referrer_kind = 'thought'
            AND m.hash IN (
              SELECT id FROM thoughts
               WHERE project_id = ? AND visibility = 'active'
            )
          ORDER BY v.distance ASC`,
      )
      .all(src.embedding, k * 2, projectId) as Array<{ id: string; distance: number }>;

    const best = new Map<string, number>();
    for (const r of rows) {
      const cur = best.get(r.id);
      if (cur === undefined || r.distance < cur) best.set(r.id, r.distance);
    }

    return [...best.entries()]
      .filter(([id]) => id !== thoughtId)
      .map(([id, distance]) => ({ id, cosine: 1 - distance }))
      .filter((c) => c.cosine >= cosineFloor)
      .slice(0, k);
  } catch {
    return [];
  }
}

interface BatchLabel {
  index: number;
  relation: string;
  justification: string;
}

async function callHaikuBatch(
  pairs: CandidatePair[],
): Promise<BatchLabel[] | null> {
  if (!canSpawnHaiku()) return null;
  recordHaikuSpawn();
  const lines: string[] = [PROMPT_PREAMBLE, "", "Pairs:"];
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    lines.push(
      `[${i}] A="${truncate(p.a.content, 280)}"  B="${truncate(p.b.content, 280)}"`,
    );
  }
  lines.push("");
  lines.push("JSON array of {i, relation, justification} only:");
  const prompt = lines.join("\n");

  try {
    const stdout = await headlessQuery({
      prompt,
      model: MODEL,
      timeoutMs: TIMEOUT_MS,
      brainInternal: true,
      purpose: "brain",
    });
    return parseBatchResponse(stdout);
  } catch {
    return null;
  }
}

function parseBatchResponse(text: string): BatchLabel[] | null {
  const fenced = /```(?:json)?\s*(\[[\s\S]*?\])\s*```/.exec(text);
  const raw = fenced
    ? fenced[1]
    : (() => {
        const first = text.indexOf("[");
        const last = text.lastIndexOf("]");
        if (first === -1 || last === -1 || last <= first) return null;
        return text.slice(first, last + 1);
      })();
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return null;
    const out: BatchLabel[] = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      const idx = typeof r.i === "number" ? r.i : Number(r.i);
      if (!Number.isFinite(idx)) continue;
      const relation = typeof r.relation === "string" ? r.relation : "null";
      const justification =
        typeof r.justification === "string" ? r.justification.slice(0, 280) : "";
      out.push({ index: Math.floor(idx), relation, justification });
    }
    return out;
  } catch {
    return null;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

interface InsertSuggestionArgs {
  org_id: string;
  project_id: string;
  from: string;
  to: string;
  relation: string;
  justification: string;
  cosine: number;
}

function insertSuggestion(
  db: Database.Database,
  args: InsertSuggestionArgs,
): boolean {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO thought_ref_suggestions
       (id, org_id, project_id, from_thought_id, to_thought_id, relation,
        confidence, cosine, justification, proposer_model, created_at, reviewed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    ).run(
      nanoid(),
      args.org_id,
      args.project_id,
      args.from,
      args.to,
      args.relation,
      args.cosine,
      args.cosine,
      args.justification,
      MODEL,
      Math.floor(Date.now() / 1000),
    );
    return true;
  } catch {
    return false;
  }
}
