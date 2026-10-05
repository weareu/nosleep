/**
 * Main search orchestrator for Phase 1. Runs enabled retrievers, fuses via
 * RRF, shapes response, logs query.
 *
 * Phase 3 added semantic retriever + cross-encoder rerank.
 * Phase 9 added optional multi-file fan-out (active + sealed) for the
 * lexical and semantic-text branches.
 */

import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { activeDbFor } from "../storage/active-db.js";
import type { QuerySpecT } from "./query-spec.js";
import { assertNonEmpty } from "./query-spec.js";
import { runBm25 } from "./retrievers/bm25.js";
import { runTemporal } from "./retrievers/temporal.js";
import { runSemanticText } from "./retrievers/semantic-text.js";
import { runCodeStructural } from "./retrievers/code-structural.js";
import { rrf, type FusedResult, type RrfInput } from "./rrf.js";
import { buildArtifactsWhere } from "./filters.js";
import { rerank, type RerankCandidate } from "./rerank.js";
import { planFanout, openFanout, type FanoutHandle } from "./fanout.js";
import type { SelectedFile } from "../storage/file-selection.js";
import {
  findThoughtsLexical,
  loadThoughtsForSearch,
} from "../thoughts/search.js";
import { markThoughtsRecalled } from "../thoughts/recall.js";
import type { ThoughtRow } from "../thoughts/types.js";

/** Which brain layer a hit came from. */
export type SearchLayer = "archive" | "thoughts";

export interface SearchResultThought {
  id: string;
  thought_type: string | null;
  visibility: string;
  topics: string[];
}

export interface SearchResultRow {
  /** Artifact hash for archive hits; thought id for thought hits. */
  hash: string;
  layer: SearchLayer;
  /** Present only when layer === "thoughts". */
  thought?: SearchResultThought;
  kind: string;
  ts: number;
  project_id: string;
  session_id: string | null;
  snippet: string;
  score: number;
  fused_rank: number;
  score_breakdown?: Record<
    string,
    { rank: number; raw_score: number; weight: number }
  >;
}

export interface SearchResponse {
  query_id: string;
  latency_ms: number;
  total_candidates: number;
  results: SearchResultRow[];
  layers_returned: { archive: number; thoughts: number };
  intent_used: string | null;
  /** Names of files (active + sealed) actually queried, for observability. */
  files_queried?: string[];
}

/**
 * Kind-aware snippet extraction. Phase 1: first 240 chars with simple text
 * decoding. Kind-specific renderers (code diff pretty-print, image caption,
 * etc.) come in Phase 5.
 */
function buildSnippet(row: {
  content: Buffer | null;
  content_type: string | null;
  text: string | null;
}): string {
  // Prefer fts_src text if present (already decoded to text)
  if (row.text) {
    return row.text.slice(0, 240).replace(/\s+/g, " ").trim();
  }
  if (!row.content) return "";
  const ct = (row.content_type ?? "").toLowerCase();
  if (
    ct.startsWith("image/") ||
    ct.startsWith("video/") ||
    ct.startsWith("audio/")
  ) {
    return "[binary content]";
  }
  return row.content.toString("utf8").slice(0, 240).replace(/\s+/g, " ").trim();
}

/**
 * Archive-only facets (kind/origin/session/actor/numeric) have no meaning on
 * thoughts; a query that sets any of them is an archive query.
 */
function hasArchiveOnlyFilters(q: QuerySpecT): boolean {
  return (
    !!q.facets?.kind_prefix?.length ||
    !!q.facets?.origin ||
    !!q.facets?.session_id ||
    !!q.facets?.actor ||
    (!!q.numeric && Object.keys(q.numeric).length > 0)
  );
}

function thoughtToResult(t: ThoughtRow, f: FusedResult, q: QuerySpecT): SearchResultRow {
  const type = t.thought_type ?? t.metadata.type ?? null;
  return {
    hash: t.id,
    layer: "thoughts",
    thought: {
      id: t.id,
      thought_type: type,
      visibility: t.visibility,
      topics: t.metadata.topics ?? [],
    },
    kind: `thought/${type ?? "observation"}`,
    ts: t.created_at,
    project_id: t.project_id,
    session_id: null,
    snippet: t.content.slice(0, 240).replace(/\s+/g, " ").trim(),
    score: f.fused_score,
    fused_rank: f.fused_rank,
    score_breakdown: q.return_score_breakdown ? f.contributions : undefined,
  };
}

export async function search(q: QuerySpecT): Promise<SearchResponse> {
  const started = performance.now();
  assertNonEmpty(q);
  const wantArchive = q.layers.includes("archive");
  const wantThoughts =
    q.layers.includes("thoughts") && !hasArchiveOnlyFilters(q);
  const thoughtScope = {
    orgId: q.org_id,
    projectId: q.project_id,
    scope: q.scope,
    includeHidden: q.include_hidden,
    includeArchived: q.include_archived,
  };

  // Decide whether to fan out across sealed files. When the query asks for
  // `time_range: "all_time"` AND there is at least one sealed file in
  // catalog, open a fresh read-only connection with all files attached.
  const fanoutFiles: SelectedFile[] | null = planFanout(q);
  let fanoutHandle: FanoutHandle | null = null;
  let db: Database.Database;
  try {
    if (fanoutFiles) {
      fanoutHandle = openFanout(fanoutFiles);
      db = fanoutHandle.db;
    } else {
      db = activeDbFor(q.org_id);
    }

    const filesForRetriever = fanoutFiles ?? undefined;

    // Phase 3 retrievers: BM25 + semantic + temporal
    const retrieverInputs: RrfInput[] = [];

    if (q.text?.query) {
      const mode = q.text.mode ?? "hybrid";
      if (wantArchive && (mode === "lexical" || mode === "hybrid")) {
        retrieverInputs.push({
          retriever: "bm25",
          results: runBm25(db, q, 200, filesForRetriever),
          weight: q.text.weight,
        });
      }
      if (mode === "semantic" || mode === "hybrid") {
        const semantic = await runSemanticText(db, q, 200, filesForRetriever);
        if (semantic.length > 0) {
          retrieverInputs.push({
            retriever: "semantic_text",
            results: semantic,
            weight: q.text.weight,
          });
        }
      }
    }

    // Thoughts layer: lexical FTS over distilled thoughts (semantic thought
    // hits already arrive via semantic_text's vec_text_map join).
    if (wantThoughts && q.text?.query) {
      const mode = q.text.mode ?? "hybrid";
      if (mode === "lexical" || mode === "hybrid") {
        const hits = findThoughtsLexical(activeDbFor(q.org_id), {
          ...thoughtScope,
          query: q.text.query,
          limit: 200,
          createdFrom: q.temporal?.from,
          createdTo: q.temporal?.to,
        });
        if (hits.length > 0) {
          retrieverInputs.push({
            retriever: "thoughts_bm25",
            results: hits.map((h, idx) => ({
              hash: h.row.id,
              rank: idx + 1,
              raw_score: h.relevance,
              retriever: "thoughts_bm25",
            })),
            weight: q.text.weight,
          });
        }
      }
    }

    if (wantArchive && q.temporal?.near_artifact) {
      retrieverInputs.push({
        retriever: "temporal",
        results: runTemporal(db, q, 200),
        weight: q.temporal.weight,
      });
    }

    // Phase 5: code-structural always runs when text is present (cheap —
    // index on code_symbols.symbol). Boosted by intent=find_code; otherwise
    // contributes softly so it doesn't overwhelm semantic on mixed content.
    if (wantArchive && q.text?.query) {
      const codeResults = runCodeStructural(db, q, 200);
      if (codeResults.length > 0) {
        const boost = q.intent === "find_code" ? 1.2 : 0.4;
        retrieverInputs.push({
          retriever: "code_structural",
          results: codeResults,
          weight: (q.text.weight ?? 1.0) * boost,
        });
      }
    }

    // If no retrievers fired (pure-filter query), do a plain ts-desc scan
    // respecting hard filters.
    let fused: FusedResult[];
    // Distinct candidates across all retrievers (a hash found by bm25 AND
    // semantic counts once).
    const totalBefore = new Set(
      retrieverInputs.flatMap((r) => r.results.map((x) => x.hash)),
    ).size;

    if (retrieverInputs.length === 0) {
      fused = wantArchive
        ? runPureFilterScan(db, q, Math.max(q.limit, 100), filesForRetriever)
        : [];
    } else {
      fused = rrf(retrieverInputs, 60, 100);
    }

    const totalCandidates = Math.max(totalBefore, fused.length);

    // Thought hits (lexical or semantic) hydrate from active.db, re-checked
    // against org/scope/visibility — never trust a retriever's join alone.
    const thoughts: Map<string, ThoughtRow> = wantThoughts
      ? loadThoughtsForSearch(
          activeDbFor(q.org_id),
          fused.slice(0, 100).map((f) => f.hash),
          thoughtScope,
        )
      : new Map();

    // Cross-encoder rerank (no-op unless a provider is installed)
    const candidatesForRerank: RerankCandidate[] = fused
      .slice(0, 100)
      .map((f) => ({
        hash: f.hash,
        text:
          thoughts.get(f.hash)?.content ??
          snippetForHash(db, f.hash, filesForRetriever) ??
          "",
      }));
    const rerankerOutput = await rerank(q.text?.query ?? "", candidatesForRerank);
    if (rerankerOutput) {
      const byHash = new Map(fused.map((f) => [f.hash, f]));
      const rerankedFused: FusedResult[] = [];
      for (const r of rerankerOutput) {
        const f = byHash.get(r.hash);
        if (f) {
          f.contributions.cross_encoder = {
            rank: r.rank,
            raw_score: r.score,
            weight: 1.0,
          };
          rerankedFused.push(f);
        }
      }
      fused = rerankedFused;
    }

    // Hydrate result rows with kind + snippet + ts. Under fan-out, an
    // artifact may live in active.db OR any sealed file — try each schema
    // until we find it.
    const results: SearchResultRow[] = [];
    const hydrateStmts = buildHydrateStatements(db, filesForRetriever);

    for (const f of fused) {
      if (results.length >= q.limit) break;
      const thought = thoughts.get(f.hash);
      if (thought) {
        results.push(thoughtToResult(thought, f, q));
        continue;
      }
      if (!wantArchive) continue;
      const row = hydrateRow(hydrateStmts, f.hash);
      if (!row) continue;

      results.push({
        hash: f.hash,
        layer: "archive",
        kind: row.kind,
        ts: row.ts,
        // Content-addressed artifacts are shared by every project that
        // ingested them; report the project the caller searched.
        project_id: q.scope === "project" ? q.project_id : row.project_id,
        session_id: row.session_id,
        snippet: buildSnippet(row),
        score: f.fused_score,
        fused_rank: f.fused_rank,
        score_breakdown: q.return_score_breakdown ? f.contributions : undefined,
      });
    }

    const thoughtIds = results
      .filter((r) => r.layer === "thoughts")
      .map((r) => r.hash);
    markThoughtsRecalled(activeDbFor(q.org_id), thoughtIds);

    const response: SearchResponse = {
      query_id: nanoid(),
      latency_ms: performance.now() - started,
      total_candidates: totalCandidates,
      results,
      layers_returned: {
        archive: results.length - thoughtIds.length,
        thoughts: thoughtIds.length,
      },
      intent_used: q.intent ?? null,
      files_queried: fanoutFiles ? fanoutFiles.map((f) => f.file_name) : undefined,
    };

    // Query log write-through. Use the cached active connection for the
    // log write — the fan-out handle is read-only.
    logQuery(activeDbFor(q.org_id), q, response, retrieverInputs);

    return response;
  } finally {
    fanoutHandle?.close();
  }
}

/**
 * Pure filter scan — no ranker — used when QuerySpec has facets/numeric/
 * temporal-range only (no ranked retrievers). Spans active + sealed when
 * fan-out is in effect.
 */
function runPureFilterScan(
  db: Database.Database,
  q: QuerySpecT,
  limit: number,
  files?: SelectedFile[],
): FusedResult[] {
  const fanout = files && files.length > 0 ? files : [
    { alias: "main", path: "", kind: "active" as const, file_name: "active.db", ts_from: null, ts_to: null },
  ];

  const branches: string[] = [];
  const params: (string | number)[] = [];
  for (const f of fanout) {
    const where = buildArtifactsWhere(q, f.alias);
    branches.push(`
      SELECT a.hash AS hash, a.ts AS ts FROM ${f.alias}.artifacts a
       WHERE ${where.sql}
    `);
    params.push(...where.params);
  }

  const sql = `
    WITH all_rows AS (${branches.join(" UNION ALL ")})
    SELECT hash, MAX(ts) AS ts FROM all_rows
     GROUP BY hash
     ORDER BY ts DESC
     LIMIT ?
  `;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as { hash: string; ts: number }[];
  return rows.map((r, idx) => ({
    hash: r.hash,
    fused_score: 1 / (60 + idx + 1),
    fused_rank: idx + 1,
    contributions: {
      pure_filter: { rank: idx + 1, raw_score: 0, weight: 1.0 },
    },
  }));
}

interface HydrateRow {
  kind: string;
  ts: number;
  project_id: string;
  session_id: string | null;
  content: Buffer | null;
  content_type: string | null;
  text: string | null;
}

interface HydrateStmts {
  // One prepared statement per schema (main + each sN), tried in order.
  perFile: Database.Statement[];
}

function buildHydrateStatements(
  db: Database.Database,
  files?: SelectedFile[],
): HydrateStmts {
  const fanout = files && files.length > 0 ? files : [
    { alias: "main", path: "", kind: "active" as const, file_name: "active.db", ts_from: null, ts_to: null },
  ];
  const perFile: Database.Statement[] = [];
  for (const f of fanout) {
    const s = f.alias;
    perFile.push(
      db.prepare(`
        SELECT a.kind AS kind, a.ts AS ts, a.project_id AS project_id,
               a.session_id AS session_id, a.content AS content,
               a.content_type AS content_type,
               (SELECT text FROM ${s}.artifacts_fts_src WHERE hash = a.hash) AS text
          FROM ${s}.artifacts a WHERE a.hash = ?
      `),
    );
  }
  return { perFile };
}

function hydrateRow(stmts: HydrateStmts, hash: string): HydrateRow | null {
  for (const stmt of stmts.perFile) {
    const row = stmt.get(hash) as HydrateRow | undefined;
    if (row) return row;
  }
  return null;
}

function snippetForHash(
  db: Database.Database,
  hash: string,
  files?: SelectedFile[],
): string | null {
  const fanout = files && files.length > 0 ? files : [
    { alias: "main", path: "", kind: "active" as const, file_name: "active.db", ts_from: null, ts_to: null },
  ];
  for (const f of fanout) {
    try {
      const row = db
        .prepare(`SELECT text FROM ${f.alias}.artifacts_fts_src WHERE hash = ?`)
        .get(hash) as { text: string } | undefined;
      if (row?.text) return row.text;
    } catch {
      /* schema missing this table — try next */
    }
  }
  return null;
}

function logQuery(
  db: Database.Database,
  q: QuerySpecT,
  resp: SearchResponse,
  inputs: RrfInput[],
): void {
  try {
    const retrieversJson = JSON.stringify(
      inputs.map((i) => ({
        retriever: i.retriever,
        weight: i.weight,
        top20: i.results.slice(0, 20).map((r) => ({
          hash: r.hash,
          rank: r.rank,
          raw: r.raw_score,
        })),
      })),
    );

    db.prepare(
      `INSERT INTO query_logs
       (query_id, ts, query_spec_json, intent, retrievers_json, fused_top_json,
        reranked_top_json, chosen_ids_json, used_ids_json,
        latency_ms, confidence_score, project_id, org_id)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, NULL, ?, ?)`,
    ).run(
      resp.query_id,
      Math.floor(Date.now() / 1000),
      JSON.stringify(q),
      q.intent ?? null,
      retrieversJson,
      JSON.stringify(resp.results.map((r) => ({ hash: r.hash, score: r.score }))),
      JSON.stringify(resp.results.map((r) => r.hash)),
      resp.latency_ms,
      q.project_id,
      q.org_id,
    );
  } catch (err) {
    // Non-fatal — logging must never fail a query
    void err;
  }
}
