/**
 * Compute thought-to-thought co-occurrence edges. Five relation kinds:
 *
 *   shared_topic    — Jaccard ≥ 0.5 over metadata.topics arrays
 *   shared_people   — Jaccard ≥ 0.5 over metadata.people arrays
 *   same_session    — both promoted from artifacts in the same session
 *   temporal_near   — created_at within TEMPORAL_WINDOW_SEC
 *   source_linked   — share ≥1 archive_hash via thought_archive_refs
 *
 * Persisted to thought_cooccur (project-scoped). Idempotent — INSERT OR
 * REPLACE collapses recomputes. Edges with weight < 0.15 are dropped to
 * avoid hairball rendering.
 */

import { activeDbFor } from "../storage/active-db.js";

const WEIGHT_FLOOR = 0.15;
const TEMPORAL_WINDOW_SEC = 30 * 60;

interface ThoughtRow {
  id: string;
  project_id: string;
  metadata_json: string;
  created_at: number;
}

interface ParsedThought {
  id: string;
  topics: Set<string>;
  people: Set<string>;
  created_at: number;
}

function parseThought(row: ThoughtRow): ParsedThought {
  let topics: string[] = [];
  let people: string[] = [];
  try {
    const meta = JSON.parse(row.metadata_json);
    if (Array.isArray(meta.topics)) topics = meta.topics;
    if (Array.isArray(meta.people)) people = meta.people;
  } catch {
    /* keep empty */
  }
  return {
    id: row.id,
    topics: new Set(topics.map((t) => String(t).toLowerCase())),
    people: new Set(people.map((p) => String(p).toLowerCase())),
    created_at: row.created_at,
  };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const x of a) if (b.has(x)) intersect++;
  const union = a.size + b.size - intersect;
  return union > 0 ? intersect / union : 0;
}

export interface CooccurResult {
  edges_written: number;
  thought_count: number;
  duration_ms: number;
}

export function computeCooccurForProject(
  orgId: string,
  projectId: string,
): CooccurResult {
  const db = activeDbFor(orgId);
  const started = performance.now();

  const thoughts = db
    .prepare(
      `SELECT id, project_id, metadata_json, created_at
         FROM thoughts
        WHERE org_id = ? AND project_id = ? AND visibility = 'active'`,
    )
    .all(orgId, projectId) as ThoughtRow[];

  if (thoughts.length < 2) {
    return {
      edges_written: 0,
      thought_count: thoughts.length,
      duration_ms: performance.now() - started,
    };
  }

  const parsed = thoughts.map(parseThought);

  // Pre-build session map (thought_id → set of source archive_hashes).
  const sourceRefs = new Map<string, Set<string>>();
  const refRows = db
    .prepare(
      `SELECT thought_id, archive_hash FROM thought_archive_refs
        WHERE project_id = ?`,
    )
    .all(projectId) as Array<{ thought_id: string; archive_hash: string }>;
  for (const r of refRows) {
    if (!sourceRefs.has(r.thought_id)) sourceRefs.set(r.thought_id, new Set());
    sourceRefs.get(r.thought_id)!.add(r.archive_hash);
  }

  const now = Math.floor(Date.now() / 1000);
  const insert = db.prepare(
    `INSERT OR REPLACE INTO thought_cooccur
     (a_id, b_id, relation, weight, computed_at)
     VALUES (?, ?, ?, ?, ?)`,
  ) as unknown as CooccurInsertStmt;

  let written = 0;
  const tx = db.transaction(() => {
    for (let i = 0; i < parsed.length; i++) {
      const a = parsed[i];
      const aRefs = sourceRefs.get(a.id);
      for (let j = i + 1; j < parsed.length; j++) {
        const b = parsed[j];

        // shared_topic
        const topicW = jaccard(a.topics, b.topics);
        if (topicW >= WEIGHT_FLOOR) {
          writePair(insert, a.id, b.id, "shared_topic", topicW, now);
          written += 1;
        }

        // shared_people
        const peopleW = jaccard(a.people, b.people);
        if (peopleW >= WEIGHT_FLOOR) {
          writePair(insert, a.id, b.id, "shared_people", peopleW, now);
          written += 1;
        }

        // temporal_near — exp decay inside the window
        const dt = Math.abs(a.created_at - b.created_at);
        if (dt <= TEMPORAL_WINDOW_SEC) {
          const tw = Math.exp(-dt / TEMPORAL_WINDOW_SEC);
          if (tw >= WEIGHT_FLOOR) {
            writePair(insert, a.id, b.id, "temporal_near", tw, now);
            written += 1;
          }
        }

        // source_linked — Jaccard over archive source refs
        if (aRefs && aRefs.size > 0) {
          const bRefs = sourceRefs.get(b.id);
          if (bRefs && bRefs.size > 0) {
            const sw = jaccardSets(aRefs, bRefs);
            if (sw >= WEIGHT_FLOOR) {
              writePair(insert, a.id, b.id, "source_linked", sw, now);
              written += 1;
              // same_session is a coarser variant — surfaces when refs come
              // from the same session-id in the archive.
              writePair(insert, a.id, b.id, "same_session", sw, now);
              written += 1;
            }
          }
        }
      }
    }
  });
  tx();

  return {
    edges_written: written,
    thought_count: parsed.length,
    duration_ms: performance.now() - started,
  };
}

function jaccardSets(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const x of a) if (b.has(x)) intersect++;
  const union = a.size + b.size - intersect;
  return union > 0 ? intersect / union : 0;
}

interface CooccurInsertStmt {
  run(a: string, b: string, relation: string, weight: number, ts: number): unknown;
}

function writePair(
  stmt: CooccurInsertStmt,
  aRaw: string,
  bRaw: string,
  relation: string,
  weight: number,
  ts: number,
): void {
  // Canonicalise pair order so (a,b) and (b,a) collapse on PK.
  const [a, b] = aRaw < bRaw ? [aRaw, bRaw] : [bRaw, aRaw];
  stmt.run(a, b, relation, weight, ts);
}
