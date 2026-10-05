/**
 * Semantic dedup for thought capture. Runs a cosine-nearest-neighbour check
 * against vec_text (thought rows only) when the vec extension is loaded
 * and an embed provider is available. Falls back silently otherwise.
 */

import type Database from "better-sqlite3";
import { getEmbedProvider } from "../extractors/embed-provider.js";
import { isVecLoaded } from "../storage/vec-loader.js";

export interface SimilarThought {
  id: string;
  content: string;
  snippet: string;
  similarity: number;
}

const COSINE_FLOOR = 0.85;

/**
 * Return up to `limit` thoughts whose content embedding is closer than
 * `1 - COSINE_FLOOR` to the provided content. Scoped to the project.
 * Returns empty [] when vec/provider isn't available so the caller can
 * fall back to FTS.
 */
export async function findSemanticallySimilarThoughts(
  db: Database.Database,
  projectId: string,
  content: string,
  limit: number = 3,
): Promise<SimilarThought[]> {
  if (!isVecLoaded(db)) return [];
  if (content.trim().length < 8) return [];

  let vec: Float32Array;
  try {
    vec = await getEmbedProvider().embed(content);
  } catch {
    return [];
  }

  const buf = Buffer.from(vec.buffer);

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
      .all(buf, limit * 3, projectId) as Array<{ id: string; distance: number }>;

    const best = new Map<string, number>();
    for (const r of rows) {
      const cur = best.get(r.id);
      if (cur === undefined || r.distance < cur) best.set(r.id, r.distance);
    }

    const candidates = [...best.entries()]
      .map(([id, distance]) => ({ id, similarity: 1 - distance }))
      .filter((c) => c.similarity >= COSINE_FLOOR)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    if (candidates.length === 0) return [];

    // Fetch content so the caller can surface snippets.
    const ids = candidates.map((c) => c.id);
    const placeholders = ids.map(() => "?").join(",");
    const contents = db
      .prepare(`SELECT id, content FROM thoughts WHERE id IN (${placeholders})`)
      .all(...ids) as Array<{ id: string; content: string }>;
    const byId = new Map(contents.map((c) => [c.id, c.content]));

    return candidates.map((c) => ({
      id: c.id,
      content: byId.get(c.id) ?? "",
      snippet: (byId.get(c.id) ?? "").slice(0, 160),
      similarity: c.similarity,
    }));
  } catch {
    return [];
  }
}
