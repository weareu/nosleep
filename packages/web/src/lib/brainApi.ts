/**
 * Brain API client. Separate from the legacy `apiFetch` because brain
 * endpoints return raw JSON (no success/data envelope).
 */

const BASE_URL = "/api";
const API_KEY = import.meta.env.VITE_API_KEY ?? "";

function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(API_KEY ? { "x-api-key": API_KEY } : {}),
  };
}

async function jsonFetch<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: headers(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path} failed: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

export interface BrainSearchResult {
  hash: string;
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

export interface BrainSearchResponse {
  query_id: string;
  latency_ms: number;
  total_candidates: number;
  results: BrainSearchResult[];
  layers_returned: { archive: number; thoughts: number };
  intent_used: string | null;
  files_queried?: string[];
}

export interface BrainQuerySpec {
  org_id: string;
  project_id: string;
  scope?: "project" | "org";
  /** "recent" = active.db only (default); "all_time" = fan out to sealed quarters */
  time_range?: "recent" | "all_time";
  text?: { query: string; mode?: "lexical" | "semantic" | "hybrid"; weight?: number };
  temporal?: { from?: number; to?: number; near_artifact?: string };
  facets?: {
    kind_prefix?: string[];
    origin?: string;
    session_id?: string;
    actor?: string;
  };
  limit?: number;
  return_score_breakdown?: boolean;
}

export async function brainSearch(q: BrainQuerySpec): Promise<BrainSearchResponse> {
  return jsonFetch("POST", "/brain/search", q);
}

export interface BrainArtifact {
  hash: string;
  kind: string;
  ts: number;
  org_id: string;
  project_id: string;
  session_id: string | null;
  turn_ord: number | null;
  origin: { tool: string; version: string | null; actor: string | null };
  content: string | null;
  content_encoding: "base64" | "utf8";
  content_type: string | null;
  size: number;
  schema_version: number;
  kind_specific_meta: unknown;
  edges?: {
    incoming: Array<{ from_hash: string; relation: string; scope: string }>;
    outgoing: Array<{ to_hash: string; relation: string; scope: string }>;
  };
  ingest_event?: unknown;
}

export async function brainGetArtifact(
  hash: string,
  orgId: string,
  include: string[] = [],
): Promise<BrainArtifact> {
  const qs = new URLSearchParams({ org_id: orgId });
  if (include.length) qs.set("include", include.join(","));
  return jsonFetch("GET", `/brain/artifacts/${hash}?${qs.toString()}`);
}

export interface BrainSessionArtifactsResponse {
  session_id: string;
  items: Array<{
    hash: string;
    kind: string;
    ts: number;
    turn_ord: number | null;
    origin_tool: string;
    actor: string | null;
    size: number;
    snippet: string | null;
    kind_specific_meta: unknown;
  }>;
  cursor: string | null;
}

export async function brainGetSessionArtifacts(
  sessionId: string,
  orgId: string,
  opts: { since?: number; limit?: number; cursor?: string; order?: "asc" | "desc" } = {},
): Promise<BrainSessionArtifactsResponse> {
  const qs = new URLSearchParams({ org_id: orgId });
  if (opts.since !== undefined) qs.set("since", String(opts.since));
  if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
  if (opts.cursor) qs.set("cursor", opts.cursor);
  if (opts.order) qs.set("order", opts.order);
  return jsonFetch(
    "GET",
    `/brain/sessions/${encodeURIComponent(sessionId)}/artifacts?${qs.toString()}`,
  );
}

export interface BrainCaptureUrlRequest {
  url: string;
  org_id: string;
  project_id: string;
  mode?: "ref" | "full";
  note?: string;
  tags?: string[];
}

export async function brainCaptureUrl(
  req: BrainCaptureUrlRequest,
): Promise<{
  link_hash: string;
  normalized_url: string;
  status: number;
  title: string | null;
  og_image: string | null;
  error: string | null;
}> {
  return jsonFetch("POST", "/brain/capture-url", req);
}

// ── Thoughts layer ────────────────────────────────────────

export interface BrainThought {
  id: string;
  org_id: string;
  project_id: string;
  content: string;
  metadata: {
    type: string;
    topics: string[];
    people: string[];
    action_items: string[];
    dates_mentioned: string[];
  };
  thought_type: string | null;
  source_kind: string;
  source_refs: Array<{ hash: string; relation: string }> | null;
  strategy_node_ref: string | null;
  created_at: number;
  updated_at: number;
  visibility: string;
  archive_refs?: Array<{ archive_hash: string; relation: string }>;
  thought_refs?: {
    outgoing: Array<{ to_thought_id: string; relation: string }>;
    incoming: Array<{ from_thought_id: string; relation: string }>;
  };
  entity_refs?: Array<{ entity_id: string; relation: string }>;
}

export async function brainListThoughts(params: {
  org_id: string;
  project_id: string;
  type?: string;
  topic?: string;
  person?: string;
  days?: number;
  limit?: number;
}): Promise<{ items: BrainThought[] }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  return jsonFetch("GET", `/brain/thoughts?${qs.toString()}`);
}

export async function brainGetThought(
  id: string,
  orgId: string,
  include: string[] = ["refs"],
): Promise<BrainThought> {
  const qs = new URLSearchParams({ org_id: orgId });
  if (include.length) qs.set("include", include.join(","));
  return jsonFetch("GET", `/brain/thoughts/${encodeURIComponent(id)}?${qs.toString()}`);
}

export async function brainCaptureThought(req: {
  content: string;
  org_id: string;
  project_id: string;
  source_kind?: string;
  thought_type_hint?: string;
}): Promise<{
  id: string;
  enqueued_extractors: string[];
  similar_existing: Array<{ id: string; content: string; snippet: string }>;
}> {
  return jsonFetch("POST", "/brain/thoughts", req);
}

export async function brainSearchThoughts(body: {
  org_id: string;
  project_id: string;
  query: string;
  limit?: number;
  scope?: "project" | "org";
}): Promise<{
  results: Array<{ thought: BrainThought; relevance: number; snippet: string }>;
}> {
  return jsonFetch("POST", "/brain/thoughts/search", body);
}

export async function brainThoughtStats(params: {
  org_id: string;
  project_id: string;
  scope?: "project" | "org";
}): Promise<{
  total: number;
  date_range: { first: number | null; last: number | null };
  types: Array<{ type: string; count: number }>;
  top_topics: Array<{ topic: string; count: number }>;
  top_people: Array<{ person: string; count: number }>;
}> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  return jsonFetch("GET", `/brain/thoughts/stats?${qs.toString()}`);
}

// ── Phase 5 image + code endpoints ───────────────────────

export interface BrainImageItem {
  hash: string;
  kind: string;
  ts: number;
  session_id: string | null;
  scene_class: string | null;
  caption: string | null;
  ocr_text: string | null;
  width: number | null;
  height: number | null;
  phash: string | null;
}

export interface BrainImageCluster {
  representative: string;
  size: number;
  hashes: string[];
}

export async function brainListImages(params: {
  org_id: string;
  project_id: string;
  scene_class?: string;
  ocr_query?: string;
  cluster?: "none" | "phash";
  cluster_radius?: number;
  limit?: number;
}): Promise<{
  items: BrainImageItem[];
  clusters: BrainImageCluster[] | null;
  total: number;
}> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  return jsonFetch("GET", `/brain/images?${qs.toString()}`);
}

// ── Hub overview ───────────────────────────────────────

export interface BrainOverviewResponse {
  counts: {
    artifacts: number;
    thoughts: number;
    images: number;
    code: number;
    sessions: number;
  };
  last_artifact_ts: number | null;
  recent_thoughts: Array<{
    id: string;
    content: string;
    thought_type: string | null;
    created_at: number;
  }>;
  recent_images: Array<{
    hash: string;
    ts: number;
    scene_class: string | null;
    caption: string | null;
  }>;
}

export async function brainOverview(params: {
  org_id: string;
  project_id?: string;
  recent_limit?: number;
}): Promise<BrainOverviewResponse> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  return jsonFetch("GET", `/brain/overview?${qs.toString()}`);
}

export interface BrainCodeSymbol {
  hash: string;
  symbol: string;
  symbol_kind: string;
  line_start: number | null;
  line_end: number | null;
  file_path: string | null;
  language: string;
  artifact_kind: string;
  ts: number;
}

export async function brainListCodeSymbols(params: {
  org_id: string;
  project_id: string;
  q?: string;
  symbol_kind?: string;
  language?: string;
  limit?: number;
}): Promise<{ items: BrainCodeSymbol[]; total: number }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  return jsonFetch("GET", `/brain/code/symbols?${qs.toString()}`);
}

export interface BrainCodeFile {
  file_path: string;
  snapshots: number;
  symbol_count: number;
  last_seen: number;
  language: string;
}

export async function brainListCodeFiles(params: {
  org_id: string;
  project_id: string;
  q?: string;
  limit?: number;
}): Promise<{ items: BrainCodeFile[]; total: number }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  return jsonFetch("GET", `/brain/code/files?${qs.toString()}`);
}

// ── Phase 6 graph endpoint ───────────────────────────────

export interface BrainGraphNode {
  id: string;
  kind: "thought" | "entity" | "artifact";
  thought_type?: string;
  entity_kind?: string;
  label: string;
  ts?: number;
  project_id?: string;
  // Phase 22-A — detail-panel payload
  project_name?: string;
  content_snippet?: string;
  degree?: number;
  topics?: string[];
  people?: string[];
  action_items?: string[];
  dates_mentioned?: string[];
  source_kind?: string;
  strategy_node_ref?: string | null;
}

export interface BrainGraphEdge {
  from: string;
  to: string;
  relation: string;
  weight: number;
  /** Phase 22-E — time-decayed effective weight. Equal to `weight`
   *  when decay_tau_days = 0 (the default). */
  effective_weight: number;
  source: "thought_refs" | "cooccur" | "entity_refs";
  ts?: number;
}

export interface BrainGraphResponse {
  nodes: BrainGraphNode[];
  edges: BrainGraphEdge[];
  density: {
    node_count: number;
    edge_count: number;
    soft_limit: number;
    hard_limit: number;
    warning: "none" | "soft" | "hard";
  };
}

export async function brainGetGraph(params: {
  org_id: string;
  project_id: string;
  layers?: string;
  since?: number;
  limit?: number;
  include_hidden?: boolean;
  decay_tau_days?: number;
}): Promise<BrainGraphResponse> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  return jsonFetch("GET", `/brain/graph?${qs.toString()}`);
}

export async function brainRecomputeGraph(args: {
  org_id: string;
  project_id: string;
}): Promise<{
  edges_written: number;
  thought_count: number;
  duration_ms: number;
}> {
  return jsonFetch("POST", "/brain/graph/recompute", args);
}

// ── Phase 7 admin endpoints ──────────────────────────────

export interface BrainStorageInfo {
  active_db_path: string;
  active_db_size_bytes: number;
  blobs_dir: string;
  sealed_files_on_disk: Array<{ name: string; size: number; mtime: number }>;
  sealed_files_catalog: unknown[];
  counts: {
    artifact_count: number;
    thought_count: number;
    entity_count: number;
    ingest_event_count: number;
    extractor_run_count: number;
    query_log_count: number;
  };
}

export async function brainAdminStorage(orgId: string): Promise<BrainStorageInfo> {
  const qs = new URLSearchParams({ org_id: orgId });
  return jsonFetch("GET", `/admin/brain/storage?${qs.toString()}`);
}

export interface BrainMetricSeries {
  points: Array<{
    ts: number;
    value: number;
    count?: number;
    avg?: number;
    p95?: number;
  }>;
  resolution: "raw" | "1h" | "1d";
}

export async function brainAdminMetrics(params: {
  org_id: string;
  metric_key: string;
  project_id?: string;
  from: number;
  to: number;
  resolution?: "raw" | "1h" | "1d";
}): Promise<BrainMetricSeries> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  return jsonFetch("GET", `/admin/brain/metrics?${qs.toString()}`);
}

export async function brainAdminEvents(params: {
  org_id: string;
  table: "ingest_events" | "extractor_runs" | "hook_fires" | "brain_session_events";
  from?: number;
  to?: number;
  session_id?: string;
  result?: string;
  limit?: number;
}): Promise<{ items: Record<string, unknown>[]; total: number }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  return jsonFetch("GET", `/admin/brain/events?${qs.toString()}`);
}

export interface QueryLogSummary {
  query_id: string;
  ts: number;
  intent: string | null;
  latency_ms: number;
  confidence_score: number | null;
  project_id: string;
  query_spec_json: string;
}

export async function brainAdminQueryLogs(params: {
  org_id: string;
  from?: number;
  to?: number;
  project_id?: string;
  limit?: number;
}): Promise<{ items: QueryLogSummary[]; total: number }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  return jsonFetch("GET", `/admin/brain/query-logs?${qs.toString()}`);
}

export async function brainAdminQueryLog(
  id: string,
  orgId: string,
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams({ org_id: orgId });
  return jsonFetch("GET", `/admin/brain/query-logs/${encodeURIComponent(id)}?${qs.toString()}`);
}

export interface BrainExtractorHealth {
  extractor: string;
  total: number;
  success: number;
  failed: number;
  skipped: number;
  avg_ms: number;
  max_ms: number;
  last_run: number;
}

export async function brainAdminExtractors(params: {
  org_id: string;
  since_hours?: number;
}): Promise<{ items: BrainExtractorHealth[]; since_hours: number }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  return jsonFetch("GET", `/admin/brain/extractors?${qs.toString()}`);
}

export interface BrainConfigItem {
  key: string;
  value: unknown;
  updated_at: number;
}

export async function brainAdminConfigList(
  orgId: string,
): Promise<{ items: BrainConfigItem[] }> {
  const qs = new URLSearchParams({ org_id: orgId });
  return jsonFetch("GET", `/admin/brain/config?${qs.toString()}`);
}

export async function brainAdminConfigSet(args: {
  org_id: string;
  key: string;
  value: unknown;
}): Promise<{ ok: boolean }> {
  return jsonFetch("POST", "/admin/brain/config", args);
}

export async function brainAdminRollup(orgId: string): Promise<{
  hour_buckets: number;
  day_buckets: number;
  duration_ms: number;
}> {
  return jsonFetch("POST", "/admin/brain/rollup", { org_id: orgId });
}

// ── Phase 10 — suggestions queue ─────────────────────────

export interface BrainSuggestion {
  id: string;
  org_id: string;
  project_id: string;
  from_thought_id: string;
  to_thought_id: string;
  relation: string;
  confidence: number;
  cosine: number | null;
  justification: string | null;
  proposer_model: string;
  created_at: number;
  reviewed: number;
  reviewed_at: number | null;
  decision: string | null;
  from_content: string | null;
  to_content: string | null;
  from_thought_type: string | null;
  to_thought_type: string | null;
}

export async function brainAdminSuggestionsList(params: {
  org_id: string;
  project_id?: string;
  reviewed?: boolean;
  limit?: number;
}): Promise<{ items: BrainSuggestion[] }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  return jsonFetch("GET", `/brain/admin/suggestions/list?${qs.toString()}`);
}

export async function brainAdminSuggestionsRun(args: {
  org_id: string;
  project_id: string;
  max_pairs?: number;
  cosine_floor?: number;
  dry_run?: boolean;
}): Promise<{
  pairs_examined: number;
  suggestions_created: number;
  batches_run: number;
  duration_ms: number;
  skipped_reason: string | null;
}> {
  return jsonFetch("POST", "/brain/admin/suggestions/run", args);
}

export async function brainAdminSuggestionDecide(
  id: string,
  args: { org_id: string; decision: "approve" | "reject" },
): Promise<{ id: string; decision: string; applied: boolean }> {
  return jsonFetch("POST", `/brain/admin/suggestions/${id}/decide`, args);
}

// ── Phase 10 — entity merge queue ────────────────────────

export interface BrainMergeProposal {
  id: string;
  org_id: string;
  from_entity_id: string;
  to_entity_id: string;
  confidence: number;
  rationale: string | null;
  proposer: string;
  created_at: number;
  reviewed: number;
  reviewed_at: number | null;
  decision: string | null;
  from_kind: string | null;
  from_canonical: string | null;
  to_kind: string | null;
  to_canonical: string | null;
}

export async function brainAdminMergeProposalsList(params: {
  org_id: string;
  reviewed?: boolean;
  limit?: number;
}): Promise<{ items: BrainMergeProposal[] }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  return jsonFetch("GET", `/brain/admin/merge-proposals/list?${qs.toString()}`);
}

export async function brainAdminMergeProposalsCreate(args: {
  org_id: string;
  from_entity_id: string;
  to_entity_id: string;
  confidence?: number;
  rationale?: string;
  proposer?: string;
}): Promise<{ id: string }> {
  return jsonFetch("POST", "/brain/admin/merge-proposals", args);
}

export async function brainAdminMergeProposalDecide(
  id: string,
  args: { org_id: string; decision: "approve" | "reject" },
): Promise<{
  id: string;
  decision: string;
  applied: boolean;
  merge_error: string | null;
}> {
  return jsonFetch("POST", `/brain/admin/merge-proposals/${id}/decide`, args);
}

// ── Phase 22-E — thought near-duplicate proposals ───────

export interface BrainThoughtMergeProposal {
  id: string;
  project_id: string;
  from_thought_id: string;
  to_thought_id: string;
  similarity: number;
  rationale: string | null;
  proposer: string;
  created_at: number;
  reviewed: number;
  reviewed_at: number | null;
  decision: string | null;
  from_content: string | null;
  from_type: string | null;
  to_content: string | null;
  to_type: string | null;
}

export async function brainAdminThoughtMergeProposalsList(params: {
  org_id: string;
  reviewed?: boolean;
  limit?: number;
}): Promise<{ items: BrainThoughtMergeProposal[] }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  return jsonFetch("GET", `/brain/admin/thought-merge-proposals/list?${qs.toString()}`);
}

export async function brainAdminThoughtMergeProposalsRun(args: {
  org_id: string;
}): Promise<{ scanned: number; proposed: number; duplicates: number; failed: number }> {
  return jsonFetch("POST", "/brain/admin/thought-merge-proposals/run", args);
}

export async function brainAdminThoughtMergeProposalDecide(
  id: string,
  args: { org_id: string; decision: "approve" | "reject" },
): Promise<{ id: string; decision: string; applied: boolean }> {
  return jsonFetch("POST", `/brain/admin/thought-merge-proposals/${id}/decide`, args);
}

// ── Phase 12 — entity hub ────────────────────────────────

export interface BrainEntityRef {
  entity_id: string;
  referrer_kind: "thought" | "artifact";
  referrer_id: string;
  relation: string;
  project_id: string;
  created_at: number;
}

export interface BrainEntityDetail {
  id: string;
  org_id: string;
  kind: string;
  canonical_name: string;
  aliases: string[];
  metadata: Record<string, unknown>;
  merged_into: string | null;
  created_at: number;
  visibility: string;
  ref_count: number;
  recent_refs: BrainEntityRef[];
  related: Array<{
    id: string;
    canonical_name: string;
    kind: string;
    co_count: number;
  }>;
  merge_target?: {
    id: string;
    canonical_name: string;
    kind: string;
  } | null;
}

export async function brainGetEntity(
  id: string,
  orgId: string,
  includeHidden = false,
): Promise<BrainEntityDetail> {
  const qs = new URLSearchParams({ org_id: orgId });
  if (includeHidden) qs.set("include_hidden", "true");
  return jsonFetch("GET", `/brain/entities/${encodeURIComponent(id)}?${qs.toString()}`);
}

export interface BrainEntityListItem {
  id: string;
  kind: string;
  canonical_name: string;
  ref_count: number;
}

export async function brainListEntities(params: {
  org_id: string;
  project_id?: string;
  kind?: string;
  order?: "ref_count" | "name" | "recent";
  limit?: number;
}): Promise<{ items: BrainEntityListItem[] }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  return jsonFetch("GET", `/brain/entities?${qs.toString()}`);
}

// ── Phase 12 (UI review M3) — shared default-window helper ─────────

/**
 * Default temporal window when no specific range is selected. Used by
 * Timeline / Search / Archive so they all behave the same.
 */
export const DEFAULT_TEMPORAL_WINDOW_S = 365 * 24 * 60 * 60;

export function defaultTemporal(): { from: number } {
  return { from: Math.floor(Date.now() / 1000) - DEFAULT_TEMPORAL_WINDOW_S };
}

// ── Capture (mirror of mobile brainApi) ────────────────────────────

export interface CaptureThoughtRequest {
  content: string;
  org_id: string;
  project_id: string;
  source_kind?: string;
  thought_type_hint?: string;
  source_refs?: Array<{ hash: string; relation: string }>;
}

export interface CaptureThoughtResult {
  id: string;
  similar_existing: Array<{ id: string; cosine: number }>;
}

export async function captureThought(
  req: CaptureThoughtRequest,
): Promise<CaptureThoughtResult> {
  return jsonFetch("POST", "/brain/thoughts", req);
}

export interface IngestResult {
  hash: string;
  duplicate: boolean;
  enqueued: string[];
  size: number;
  latency_ms: number;
}

// ── Session replay (used by SessionDetail backfill) ────────────────

export interface SessionArtifactItem {
  hash: string;
  kind: string;
  ts: number;
  turn_ord: number | null;
  origin_tool: string | null;
  actor: string | null;
  size: number;
  snippet: string | null;
}

export interface SessionArtifactsPage {
  items: SessionArtifactItem[];
  next_cursor: string | null;
}

export async function fetchSessionArtifacts(args: {
  session_id: string;
  org_id: string;
  limit?: number;
  order?: "asc" | "desc";
}): Promise<SessionArtifactsPage> {
  const qs = new URLSearchParams();
  qs.set("org_id", args.org_id);
  qs.set("order", args.order ?? "asc");
  qs.set("limit", String(args.limit ?? 200));
  return jsonFetch(
    "GET",
    `/brain/sessions/${encodeURIComponent(args.session_id)}/artifacts?${qs.toString()}`,
  );
}

export async function ingestAudio(args: {
  base64: string;
  content_type: string; // "audio/webm", "audio/mp4" etc.
  org_id: string;
  project_id: string;
  duration_ms?: number;
  transcript?: string;
}): Promise<IngestResult> {
  return jsonFetch("POST", "/brain/ingest", {
    kind: "conversation/voice_note/recording",
    content: args.base64,
    content_type: args.content_type,
    org_id: args.org_id,
    project_id: args.project_id,
    origin: { tool: "nosleep-web", actor: "user" },
    kind_specific_meta: {
      duration_ms: args.duration_ms,
      transcript: args.transcript,
    },
    schema_version: 1,
  });
}
