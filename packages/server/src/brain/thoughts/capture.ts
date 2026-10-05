/**
 * Thought capture. Insert happens synchronously with placeholder metadata;
 * the LLM extractor fills metadata async. Also handles search-before-capture
 * dedup notification (Phase 2 uses FTS only; Phase 3 upgrades to semantic).
 */

import { nanoid } from "nanoid";
import { activeDbFor } from "../storage/active-db.js";
import {
  scheduleMetadataExtraction,
  scheduleTextEmbedding,
} from "../extractors/worker.js";
import { findSemanticallySimilarThoughts } from "./dedup.js";
import {
  type CaptureThoughtRequestT,
  type ThoughtRow,
  type ThoughtTypeT,
  initialMetadata,
} from "./types.js";

export interface CaptureResult {
  id: string;
  enqueued_extractors: string[];
  similar_existing: Array<{
    id: string;
    content: string;
    snippet: string;
    similarity?: number;
    method?: "fts" | "semantic";
  }>;
}

/**
 * Dedup pre-check. Phase 3: FTS-based — Phase 3's semantic dedup upgrade
 * runs in a post-capture async hook (see dedup-worker) because the embedder
 * is async. The FTS phrase match here is still useful for cheap exact/near
 * duplicates without paying a capture-path embedding cost.
 */
function findSimilar(
  db: ReturnType<typeof activeDbFor>,
  projectId: string,
  content: string,
): Array<{ id: string; content: string; snippet: string }> {
  const words = content.split(/\s+/).slice(0, 10).filter(Boolean);
  if (words.length < 2) return [];
  const ftsQuery = `"${words.join(" ").replace(/"/g, "")}"`;
  try {
    const rows = db
      .prepare(
        `SELECT t.id, t.content
           FROM thoughts_fts f
           JOIN thoughts t ON t.id = f.id
          WHERE f.content MATCH ?
            AND t.project_id = ?
            AND t.visibility = 'active'
          LIMIT 3`,
      )
      .all(ftsQuery, projectId) as { id: string; content: string }[];
    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      snippet: r.content.slice(0, 160),
    }));
  } catch {
    return [];
  }
}

/**
 * Insert a new thought and enqueue extractors. Returns the new id along with
 * any similar existing thoughts the caller can surface to the user.
 */
export function captureThought(req: CaptureThoughtRequestT): CaptureResult {
  const db = activeDbFor(req.org_id);
  const id = `thg_${nanoid(16)}`;
  const now = Math.floor(Date.now() / 1000);
  const metadata = initialMetadata(req.thought_type_hint);
  const similar = findSimilar(db, req.project_id, req.content);

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO thoughts
       (id, org_id, project_id, content, metadata_json, thought_type,
        source_kind, source_refs_json, strategy_node_ref,
        created_at, updated_at, visibility)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    ).run(
      id,
      req.org_id,
      req.project_id,
      req.content,
      JSON.stringify(metadata),
      metadata.type,
      req.source_kind,
      req.source_refs ? JSON.stringify(req.source_refs) : null,
      req.strategy_node_ref ?? null,
      now,
      now,
    );

    // FTS5 sync (no automatic triggers on thoughts_fts — manual INSERT)
    db.prepare(
      `INSERT INTO thoughts_fts
       (id, project_id, thought_type, content, topics_flat, people_flat,
        actions_flat, created_at)
       VALUES (?, ?, ?, ?, '', '', '', ?)`,
    ).run(id, req.project_id, metadata.type, req.content, now);

    // Persist archive bridge refs so reverse lookup is fast
    if (req.source_refs?.length) {
      const stmt = db.prepare(
        `INSERT OR IGNORE INTO thought_archive_refs
         (thought_id, archive_hash, relation, project_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const ref of req.source_refs) {
        stmt.run(id, ref.hash, ref.relation, req.project_id, now);
      }
    }
  });
  tx();

  // Enqueue extractors (Phase 3: metadata_llm + embedding_text)
  const enqueued = ["metadata_llm", "embedding_text"];

  // Fire-and-forget to the worker. Not awaited; extractor failures are
  // non-fatal for capture.
  scheduleMetadataExtraction(req.org_id, id).catch(() => {
    /* non-fatal */
  });
  scheduleTextEmbedding({
    referrer_kind: "thought",
    hash: id,
    text: req.content,
    project_id: req.project_id,
    org_id: req.org_id,
  }).catch(() => {
    /* non-fatal */
  });

  return {
    id,
    enqueued_extractors: enqueued,
    similar_existing: similar.map((s) => ({ ...s, method: "fts" as const })),
  };
}

/**
 * Async variant: upgrades the similar-existing pre-check to semantic cosine
 * when vec + provider are available, else falls back to the FTS results that
 * the synchronous captureThought returns. Callers with async context
 * (HTTP handlers, MCP tools) should prefer this.
 */
export async function captureThoughtAsync(
  req: CaptureThoughtRequestT,
): Promise<CaptureResult> {
  const db = activeDbFor(req.org_id);
  const semantic = await findSemanticallySimilarThoughts(
    db,
    req.project_id,
    req.content,
    3,
  );
  const result = captureThought(req);
  if (semantic.length > 0) {
    result.similar_existing = semantic.map((s) => ({
      id: s.id,
      content: s.content,
      snippet: s.snippet,
      similarity: s.similarity,
      method: "semantic",
    }));
  }
  return result;
}

/** Hydrate a thoughts row from SQLite into a typed object. */
export function rowToThought(row: {
  id: string;
  org_id: string;
  project_id: string;
  content: string;
  metadata_json: string;
  thought_type: string | null;
  source_kind: string;
  source_refs_json: string | null;
  strategy_node_ref: string | null;
  created_at: number;
  updated_at: number;
  visibility: string;
}): ThoughtRow {
  const metadata = safeJson<{
    type: ThoughtTypeT;
    topics: string[];
    people: string[];
    action_items: string[];
    dates_mentioned: string[];
  }>(row.metadata_json) ?? {
    type: "observation",
    topics: [],
    people: [],
    action_items: [],
    dates_mentioned: [],
  };
  const refs = row.source_refs_json
    ? safeJson<Array<{ hash: string; relation: string }>>(row.source_refs_json)
    : null;

  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    content: row.content,
    metadata,
    thought_type: (row.thought_type as ThoughtTypeT | null) ?? null,
    source_kind: row.source_kind as ThoughtRow["source_kind"],
    source_refs: refs ?? null,
    strategy_node_ref: row.strategy_node_ref,
    created_at: row.created_at,
    updated_at: row.updated_at,
    visibility: row.visibility,
  };
}

function safeJson<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
