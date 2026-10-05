/**
 * related_thoughts retrieval. Combines four modalities:
 *
 *   - edges:      explicit thought_refs (outgoing + incoming)
 *   - entities:   thoughts sharing ≥1 entity_ref with this thought
 *   - session:    thoughts produced in the same session via source_refs →
 *                 archive artifact chain (best-effort — we look at shared
 *                 archive_refs)
 *   - topics:     thoughts whose metadata.topics intersects this thought's
 *
 * Each modality contributes weighted evidence; we score by sum of weights
 * per target thought and return the top-N distinct. No semantic similarity
 * here — `search_thoughts` handles that path.
 */

import { activeDbFor } from "../storage/active-db.js";
import { rowToThought } from "./capture.js";
import type { ThoughtRow } from "./types.js";

export type RelatedModality = "edges" | "entities" | "shared_session" | "topics";

export interface RelatedThoughtResult {
  thought: ThoughtRow;
  score: number;
  signals: Array<{ modality: RelatedModality; detail: string; weight: number }>;
}

interface Accumulator {
  score: number;
  signals: Array<{ modality: RelatedModality; detail: string; weight: number }>;
}

const DEFAULT_MODALITIES: RelatedModality[] = [
  "edges",
  "entities",
  "shared_session",
  "topics",
];

export function relatedThoughts(
  orgId: string,
  thoughtId: string,
  opts: { modalities?: RelatedModality[]; limit?: number } = {},
): RelatedThoughtResult[] {
  const db = activeDbFor(orgId);
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 100));
  const modalities = new Set(opts.modalities ?? DEFAULT_MODALITIES);

  const source = db
    .prepare(
      `SELECT id, project_id, metadata_json FROM thoughts WHERE id = ? AND org_id = ?`,
    )
    .get(thoughtId, orgId) as
    | { id: string; project_id: string; metadata_json: string }
    | undefined;
  if (!source) return [];

  const scores = new Map<string, Accumulator>();
  const addScore = (
    targetId: string,
    modality: RelatedModality,
    detail: string,
    weight: number,
  ) => {
    if (targetId === thoughtId) return;
    const cur = scores.get(targetId) ?? { score: 0, signals: [] };
    cur.score += weight;
    cur.signals.push({ modality, detail, weight });
    scores.set(targetId, cur);
  };

  // 1. Explicit edges — outgoing + incoming, weight 1.0
  if (modalities.has("edges")) {
    const edges = db
      .prepare(
        `SELECT to_thought_id AS other, relation, 'outgoing' AS dir FROM thought_refs WHERE from_thought_id = ?
         UNION ALL
         SELECT from_thought_id AS other, relation, 'incoming' AS dir FROM thought_refs WHERE to_thought_id = ?`,
      )
      .all(thoughtId, thoughtId) as Array<{
      other: string;
      relation: string;
      dir: string;
    }>;
    for (const e of edges) {
      addScore(e.other, "edges", `${e.dir}:${e.relation}`, 1.0);
    }
  }

  // 2. Shared entities — Jaccard-like: count shared entity_refs
  if (modalities.has("entities")) {
    const rows = db
      .prepare(
        `SELECT r2.referrer_id AS other, COUNT(*) AS shared
           FROM entity_refs r1
           JOIN entity_refs r2 ON r2.entity_id = r1.entity_id
          WHERE r1.referrer_kind = 'thought'
            AND r1.referrer_id = ?
            AND r2.referrer_kind = 'thought'
            AND r2.referrer_id != r1.referrer_id
          GROUP BY r2.referrer_id
          ORDER BY shared DESC
          LIMIT 50`,
      )
      .all(thoughtId) as Array<{ other: string; shared: number }>;
    for (const r of rows) {
      addScore(r.other, "entities", `shared=${r.shared}`, 0.5 * r.shared);
    }
  }

  // 3. Shared session via shared archive refs
  if (modalities.has("shared_session")) {
    const rows = db
      .prepare(
        `SELECT r2.thought_id AS other, COUNT(*) AS shared
           FROM thought_archive_refs r1
           JOIN thought_archive_refs r2 ON r2.archive_hash = r1.archive_hash
          WHERE r1.thought_id = ?
            AND r2.thought_id != r1.thought_id
          GROUP BY r2.thought_id
          ORDER BY shared DESC
          LIMIT 30`,
      )
      .all(thoughtId) as Array<{ other: string; shared: number }>;
    for (const r of rows) {
      addScore(r.other, "shared_session", `shared_refs=${r.shared}`, 0.3 * r.shared);
    }
  }

  // 4. Shared topics — intersect metadata.topics
  if (modalities.has("topics")) {
    let topics: string[] = [];
    try {
      const meta = JSON.parse(source.metadata_json);
      topics = Array.isArray(meta.topics) ? meta.topics.slice(0, 10) : [];
    } catch {
      /* ignore */
    }
    if (topics.length > 0) {
      const placeholders = topics.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT t.id AS other, COUNT(*) AS shared
             FROM thoughts t, json_each(t.metadata_json, '$.topics') je
            WHERE t.org_id = ?
              AND t.visibility = 'active'
              AND t.id != ?
              AND je.value IN (${placeholders})
            GROUP BY t.id
            ORDER BY shared DESC
            LIMIT 40`,
        )
        .all(orgId, thoughtId, ...topics) as Array<{
        other: string;
        shared: number;
      }>;
      for (const r of rows) {
        addScore(r.other, "topics", `shared=${r.shared}`, 0.25 * r.shared);
      }
    }
  }

  // Hydrate top-N
  const ranked = [...scores.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit);

  if (ranked.length === 0) return [];

  const ids = ranked.map(([id]) => id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, org_id, project_id, content, metadata_json, thought_type,
              source_kind, source_refs_json, strategy_node_ref,
              created_at, updated_at, visibility
         FROM thoughts WHERE id IN (${placeholders})`,
    )
    .all(...ids) as Parameters<typeof rowToThought>[0][];
  const byId = new Map(rows.map((r) => [r.id, rowToThought(r)]));

  return ranked
    .map(([id, acc]) => {
      const thought = byId.get(id);
      if (!thought) return null;
      return { thought, score: acc.score, signals: acc.signals };
    })
    .filter((x): x is RelatedThoughtResult => x !== null);
}
