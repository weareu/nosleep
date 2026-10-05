/**
 * Build a graph response shape for the D3 view. Includes thoughts +
 * entities (default) and archive artifacts (opt-in via query). Edges come
 * from thought_refs (explicit), thought_cooccur (derived), and entity_refs
 * (thought→entity links rendered as thin edges).
 *
 * Density-aware: returns warnings/limits when node count crosses the soft
 * (500) and hard (1200) thresholds — the client uses these to switch
 * layout modes.
 */

import type Database from "better-sqlite3";
import { activeDbFor } from "../storage/active-db.js";

const SOFT_NODE_LIMIT = 500;
const HARD_NODE_LIMIT = 1200;

export interface GraphNode {
  id: string;
  kind: "thought" | "entity" | "artifact";
  thought_type?: string;
  entity_kind?: string;
  label: string;
  ts?: number;
  project_id?: string;
  // Phase 22-A — detail-panel context. These fields are populated for
  // thought + artifact nodes (entities have no project / snippet).
  project_name?: string;
  content_snippet?: string;
  degree?: number;
  topics?: string[];
  people?: string[];
  action_items?: string[];
  dates_mentioned?: string[];
  strategy_node_ref?: string | null;
  source_kind?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  relation: string;
  /** Base (un-decayed) weight from source data — co-occur count, ref
   *  type, etc. Kept so the client can re-decay with a different tau
   *  without a round-trip. */
  weight: number;
  /** Effective weight after time-decay (Phase 22-E). Equal to `weight`
   *  when decay_tau_days = 0. Always populated. */
  effective_weight: number;
  source: "thought_refs" | "cooccur" | "entity_refs";
  /** Source timestamp the decay was computed against. Optional — only
   *  set when the edge has a meaningful creation time. */
  ts?: number;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  density: {
    node_count: number;
    edge_count: number;
    soft_limit: number;
    hard_limit: number;
    warning: "none" | "soft" | "hard";
  };
}

export interface GraphOptions {
  org_id: string;
  project_id: string;
  layers?: Array<"thoughts" | "entities" | "archive">;
  since?: number;
  limit?: number;
  include_hidden?: boolean;
  /** Phase 22-A — main DB to resolve project names. Optional so the
   *  function still works in test contexts without a main db. */
  mainDb?: Database.Database;
  /** Phase 22-E — time-decay tau in days. effective_weight = weight ×
   *  exp(-Δdays / tau). 0 disables decay (effective_weight = weight). */
  decay_tau_days?: number;
}

interface ThoughtMetadata {
  topics?: string[];
  people?: string[];
  action_items?: string[];
  dates_mentioned?: string[];
}

function parseMeta(raw: string | null): ThoughtMetadata {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ThoughtMetadata;
  } catch {
    return {};
  }
}

/** Compute the effective edge weight after time-decay. `tau` of 0
 *  disables decay (returns the raw weight). `ts` of undefined likewise
 *  — we have no anchor point to decay from. */
function decayWeight(weight: number, ts: number | undefined, nowUnix: number, tauDays: number): number {
  if (!tauDays || !ts) return weight;
  const ageDays = Math.max(0, (nowUnix - ts) / 86_400);
  return weight * Math.exp(-ageDays / tauDays);
}

export function buildGraph(opts: GraphOptions): GraphResponse {
  const db = activeDbFor(opts.org_id);
  const layers = new Set(opts.layers ?? ["thoughts", "entities"]);
  const limit = Math.max(50, Math.min(opts.limit ?? 500, HARD_NODE_LIMIT));

  const nodes: GraphNode[] = [];
  const nodeIds = new Set<string>();
  const edges: GraphEdge[] = [];

  // Resolve project_id → project_name once. Used to enrich every node
  // for the detail panel so the UI doesn't have to round-trip per click.
  const projectName: string | undefined = opts.mainDb
    ? (
        opts.mainDb
          .prepare("SELECT name FROM projects WHERE id = ?")
          .get(opts.project_id) as { name: string } | undefined
      )?.name
    : undefined;

  // 1. Thoughts (nodes)
  if (layers.has("thoughts")) {
    const conds = ["project_id = ?"];
    const params: (string | number)[] = [opts.project_id];
    if (!opts.include_hidden) conds.push("visibility = 'active'");
    if (opts.since !== undefined) {
      conds.push("created_at >= ?");
      params.push(opts.since);
    }
    const rows = db
      .prepare(
        `SELECT id, content, thought_type, created_at, project_id,
                metadata_json, source_kind, strategy_node_ref
           FROM thoughts WHERE ${conds.join(" AND ")}
           ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...params, limit) as Array<{
      id: string;
      content: string;
      thought_type: string | null;
      created_at: number;
      project_id: string;
      metadata_json: string | null;
      source_kind: string | null;
      strategy_node_ref: string | null;
    }>;
    for (const r of rows) {
      const meta = parseMeta(r.metadata_json);
      nodes.push({
        id: r.id,
        kind: "thought",
        thought_type: r.thought_type ?? "observation",
        label: r.content.slice(0, 80),
        ts: r.created_at,
        project_id: r.project_id,
        project_name: projectName,
        content_snippet: r.content.slice(0, 400),
        topics: meta.topics ?? [],
        people: meta.people ?? [],
        action_items: meta.action_items ?? [],
        dates_mentioned: meta.dates_mentioned ?? [],
        source_kind: r.source_kind ?? undefined,
        strategy_node_ref: r.strategy_node_ref,
      });
      nodeIds.add(r.id);
    }
  }

  // 2. Entities — only those referenced by visible thoughts (relevance filter)
  if (layers.has("entities") && nodeIds.size > 0) {
    // Snapshot the thought-only ID list BEFORE we start adding entity nodes.
    const thoughtIds = [...nodeIds];
    const placeholders = thoughtIds.map(() => "?").join(",");
    const entRows = db
      .prepare(
        `SELECT DISTINCT e.id AS id, e.kind AS entity_kind,
                e.canonical_name AS canonical_name
           FROM entity_refs r
           JOIN entities e ON e.id = r.entity_id
          WHERE r.referrer_kind = 'thought'
            AND r.referrer_id IN (${placeholders})
            AND e.merged_into IS NULL
            AND e.visibility = 'active'`,
      )
      .all(...thoughtIds) as Array<{
      id: string;
      entity_kind: string;
      canonical_name: string;
    }>;
    for (const e of entRows) {
      if (nodeIds.has(e.id)) continue;
      nodes.push({
        id: e.id,
        kind: "entity",
        entity_kind: e.entity_kind,
        label: e.canonical_name,
      });
      nodeIds.add(e.id);
    }

    // Entity edges — same thoughtIds list so placeholders align with params
    const refRows = db
      .prepare(
        `SELECT entity_id, referrer_id FROM entity_refs
          WHERE referrer_kind = 'thought'
            AND referrer_id IN (${placeholders})
            AND project_id = ?`,
      )
      .all(...thoughtIds, opts.project_id) as Array<{
      entity_id: string;
      referrer_id: string;
    }>;
    for (const r of refRows) {
      if (nodeIds.has(r.entity_id) && nodeIds.has(r.referrer_id)) {
        edges.push({
          from: r.referrer_id,
          to: r.entity_id,
          relation: "mentions",
          weight: 0.3,
          source: "entity_refs", effective_weight: 0,
        });
      }
    }
  }

  // 3. Optional: archive artifacts referenced by visible thoughts
  if (layers.has("archive") && nodeIds.size > 0) {
    const placeholders = [...nodeIds].filter((id) => id.startsWith("thg_")).map(() => "?").join(",");
    const thoughtIds = [...nodeIds].filter((id) => id.startsWith("thg_"));
    if (placeholders.length > 0) {
      const artRows = db
        .prepare(
          `SELECT DISTINCT a.hash AS id, a.kind AS kind, a.ts AS ts,
                  a.project_id AS project_id, tar.thought_id AS thought_id
             FROM thought_archive_refs tar
             JOIN artifacts a ON a.hash = tar.archive_hash
            WHERE tar.thought_id IN (${placeholders})
              AND tar.project_id = ?
            LIMIT 200`,
        )
        .all(...thoughtIds, opts.project_id) as Array<{
        id: string;
        kind: string;
        ts: number;
        project_id: string;
        thought_id: string;
      }>;
      for (const a of artRows) {
        if (!nodeIds.has(a.id)) {
          // Phase 22-A — fetch a short content preview for the panel.
          const preview = db
            .prepare("SELECT content FROM artifacts WHERE hash = ?")
            .get(a.id) as { content: Buffer | string | null } | undefined;
          let snippet: string | undefined;
          if (preview?.content) {
            const raw =
              typeof preview.content === "string"
                ? preview.content
                : preview.content.toString("utf8");
            snippet = raw.slice(0, 400);
          }
          nodes.push({
            id: a.id,
            kind: "artifact",
            label: a.kind,
            ts: a.ts,
            project_id: a.project_id,
            project_name: projectName,
            content_snippet: snippet,
          });
          nodeIds.add(a.id);
        }
        edges.push({
          from: a.thought_id,
          to: a.id,
          relation: "distilled_from",
          weight: 0.4,
          source: "entity_refs", effective_weight: 0,
        });
      }
    }
  }

  // 4. Explicit thought_refs edges (intra-graph)
  if (layers.has("thoughts") && nodeIds.size > 0) {
    const placeholders = [...nodeIds].filter((id) => id.startsWith("thg_")).map(() => "?").join(",");
    const tIds = [...nodeIds].filter((id) => id.startsWith("thg_"));
    if (tIds.length > 0) {
      const refRows = db
        .prepare(
          `SELECT from_thought_id, to_thought_id, relation
             FROM thought_refs
            WHERE from_thought_id IN (${placeholders})
              AND to_thought_id IN (${placeholders})`,
        )
        .all(...tIds, ...tIds) as Array<{
        from_thought_id: string;
        to_thought_id: string;
        relation: string;
      }>;
      for (const r of refRows) {
        edges.push({
          from: r.from_thought_id,
          to: r.to_thought_id,
          relation: r.relation,
          weight: 1.0,
          source: "thought_refs", effective_weight: 0,
        });
      }
    }
  }

  // 5. Co-occurrence edges
  if (layers.has("thoughts") && nodeIds.size > 0) {
    const tIds = [...nodeIds].filter((id) => id.startsWith("thg_"));
    if (tIds.length > 0) {
      const placeholders = tIds.map(() => "?").join(",");
      const coRows = db
        .prepare(
          `SELECT a_id, b_id, relation, weight FROM thought_cooccur
            WHERE a_id IN (${placeholders}) AND b_id IN (${placeholders})`,
        )
        .all(...tIds, ...tIds) as Array<{
        a_id: string;
        b_id: string;
        relation: string;
        weight: number;
      }>;
      for (const r of coRows) {
        edges.push({
          from: r.a_id,
          to: r.b_id,
          relation: r.relation,
          weight: r.weight,
          source: "cooccur", effective_weight: 0,
        });
      }
    }
  }

  // Phase 22-A — compute per-node degree (in+out) so the UI can sort,
  // size, and filter orphans without a second pass.
  const degById = new Map<string, number>();
  for (const e of edges) {
    degById.set(e.from, (degById.get(e.from) ?? 0) + 1);
    degById.set(e.to, (degById.get(e.to) ?? 0) + 1);
  }
  for (const n of nodes) n.degree = degById.get(n.id) ?? 0;

  // Phase 22-E — compute effective_weight per edge with time-decay.
  // Edge tables don't carry their own ts (mostly), so derive from
  // node ts: newer of (from.ts, to.ts). If neither has ts, no decay.
  // tau of 0 (or unset) disables decay — effective_weight = weight.
  const tauDays = opts.decay_tau_days ?? 0;
  const nowUnix = Math.floor(Date.now() / 1000);
  const tsById = new Map<string, number>();
  for (const n of nodes) {
    if (typeof n.ts === "number") tsById.set(n.id, n.ts);
  }
  for (const e of edges) {
    const fromTs = tsById.get(e.from);
    const toTs = tsById.get(e.to);
    const edgeTs =
      fromTs !== undefined && toTs !== undefined
        ? Math.max(fromTs, toTs)
        : fromTs ?? toTs;
    e.ts = edgeTs;
    e.effective_weight = decayWeight(e.weight, edgeTs, nowUnix, tauDays);
  }

  const warning: "none" | "soft" | "hard" =
    nodes.length >= HARD_NODE_LIMIT
      ? "hard"
      : nodes.length >= SOFT_NODE_LIMIT
        ? "soft"
        : "none";

  return {
    nodes,
    edges,
    density: {
      node_count: nodes.length,
      edge_count: edges.length,
      soft_limit: SOFT_NODE_LIMIT,
      hard_limit: HARD_NODE_LIMIT,
      warning,
    },
  };
}
