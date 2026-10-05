/**
 * HTTP client for the NoSleep brain API. Thin wrapper that forwards tool
 * calls through `/api/brain/*` endpoints. Keeps the MCP layer decoupled
 * from brain schema/storage internals.
 */

const SERVER_URL = process.env.NOSLEEP_SERVER_URL ?? "http://localhost:3777";
const API_KEY = process.env.NOSLEEP_API_KEY;

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) h["x-api-key"] = API_KEY;
  return h;
}

async function jsonFetch<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${SERVER_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: headers(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`brain API ${method} ${path} → ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export interface SearchResponse {
  query_id: string;
  latency_ms: number;
  total_candidates: number;
  results: Array<{
    hash: string;
    kind: string;
    ts: number;
    project_id: string;
    session_id: string | null;
    snippet: string;
    score: number;
    fused_rank: number;
    score_breakdown?: unknown;
  }>;
  layers_returned: { archive: number; thoughts: number };
  intent_used: string | null;
}

export async function searchArchive(
  querySpec: Record<string, unknown>,
): Promise<SearchResponse> {
  return jsonFetch("POST", "/api/brain/search", querySpec);
}

export async function getArtifact(
  hash: string,
  orgId: string,
  include?: string[],
): Promise<unknown> {
  const qs = new URLSearchParams({ org_id: orgId });
  if (include?.length) qs.set("include", include.join(","));
  return jsonFetch("GET", `/api/brain/artifacts/${hash}?${qs.toString()}`);
}

export interface SessionArtifactsResponse {
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

export async function sessionArtifacts(
  sessionId: string,
  orgId: string,
  opts: { since?: number; limit?: number; cursor?: string; order?: "asc" | "desc" } = {},
): Promise<SessionArtifactsResponse> {
  const qs = new URLSearchParams({ org_id: orgId });
  if (opts.since !== undefined) qs.set("since", String(opts.since));
  if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
  if (opts.cursor) qs.set("cursor", opts.cursor);
  if (opts.order) qs.set("order", opts.order);
  return jsonFetch(
    "GET",
    `/api/brain/sessions/${encodeURIComponent(sessionId)}/artifacts?${qs.toString()}`,
  );
}

export interface CaptureUrlResponse {
  link_hash: string;
  normalized_url: string;
  status: number;
  title: string | null;
  og_image: string | null;
  error: string | null;
  fetch_enqueued?: boolean;
}

export async function captureUrl(req: {
  url: string;
  org_id: string;
  project_id: string;
  mode?: "ref" | "full";
  note?: string;
  tags?: string[];
  thought_type_hint?: string;
}): Promise<CaptureUrlResponse> {
  return jsonFetch("POST", "/api/brain/capture-url", req);
}

// ── Thoughts layer ────────────────────────────────────────

export interface CaptureThoughtResult {
  id: string;
  enqueued_extractors: string[];
  similar_existing: Array<{ id: string; content: string; snippet: string }>;
}

export async function captureThoughtApi(req: {
  content: string;
  org_id: string;
  project_id: string;
  source_kind?: string;
  source_refs?: Array<{ hash: string; relation: string }>;
  thought_type_hint?: string;
  strategy_node_ref?: string;
}): Promise<CaptureThoughtResult> {
  return jsonFetch("POST", "/api/brain/thoughts", req);
}

export interface ThoughtDto {
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
  created_at: number;
  updated_at: number;
  visibility: string;
}

export async function listThoughtsApi(params: {
  org_id: string;
  project_id: string;
  type?: string;
  topic?: string;
  person?: string;
  days?: number;
  limit?: number;
  include_archived?: boolean;
}): Promise<{ items: ThoughtDto[] }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  return jsonFetch("GET", `/api/brain/thoughts?${qs.toString()}`);
}

export async function searchThoughtsApi(body: {
  org_id: string;
  project_id: string;
  query: string;
  limit?: number;
  threshold?: number;
  scope?: "project" | "org";
  include_archived?: boolean;
}): Promise<{ results: Array<{ thought: ThoughtDto; relevance: number; snippet: string }> }> {
  return jsonFetch("POST", "/api/brain/thoughts/search", body);
}

export async function unarchiveThoughtsApi(body: {
  org_id: string;
  ids: string[];
  pin?: boolean;
}): Promise<{ restored: string[]; not_archived: string[] }> {
  return jsonFetch("POST", "/api/brain/thoughts/unarchive", body);
}

export async function getThoughtApi(
  id: string,
  orgId: string,
  include: string[] = [],
): Promise<ThoughtDto & Record<string, unknown>> {
  const qs = new URLSearchParams({ org_id: orgId });
  if (include.length) qs.set("include", include.join(","));
  return jsonFetch("GET", `/api/brain/thoughts/${encodeURIComponent(id)}?${qs.toString()}`);
}

export async function thoughtStatsApi(params: {
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
  return jsonFetch("GET", `/api/brain/thoughts/stats?${qs.toString()}`);
}

export async function promoteArtifactApi(req: {
  archive_hash: string;
  org_id: string;
  project_id: string;
  thought_type_hint?: string;
  relation?: string;
}): Promise<CaptureThoughtResult> {
  return jsonFetch("POST", "/api/brain/thoughts/promote-artifact", req);
}

// ── Phase 4: entities + thought_refs + related ──────────

export interface RelatedThoughtDto {
  thought: ThoughtDto;
  score: number;
  signals: Array<{ modality: string; detail: string; weight: number }>;
}

export async function relatedThoughtsApi(
  thoughtId: string,
  orgId: string,
  opts: { modalities?: string[]; limit?: number } = {},
): Promise<{ items: RelatedThoughtDto[] }> {
  const qs = new URLSearchParams({ org_id: orgId });
  if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
  if (opts.modalities?.length) qs.set("modalities", opts.modalities.join(","));
  return jsonFetch(
    "GET",
    `/api/brain/thoughts/${encodeURIComponent(thoughtId)}/related?${qs.toString()}`,
  );
}

export async function addThoughtRefApi(req: {
  org_id: string;
  from_thought_id: string;
  to_thought_id: string;
  relation: string;
  origin?: string;
}): Promise<{
  created: boolean;
  project_id: string;
  scope: "intra_project" | "cross_project";
}> {
  return jsonFetch("POST", "/api/brain/thought-refs", req);
}

export interface EntitySummary {
  id: string;
  org_id: string;
  kind: string;
  canonical_name: string;
  aliases: string[];
  ref_count: number;
  created_at: number;
}

export async function listEntitiesApi(params: {
  org_id: string;
  project_id?: string;
  kind?: string;
  order?: "frequency" | "recent" | "alpha";
  limit?: number;
}): Promise<{ items: EntitySummary[] }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  return jsonFetch("GET", `/api/brain/entities?${qs.toString()}`);
}

export async function getEntityApi(
  id: string,
  orgId: string,
): Promise<EntitySummary & Record<string, unknown>> {
  const qs = new URLSearchParams({ org_id: orgId });
  return jsonFetch("GET", `/api/brain/entities/${encodeURIComponent(id)}?${qs.toString()}`);
}

// ── Phase 7: observability MCP endpoints ─────────────────

export interface MetricSeries {
  points: Array<{
    ts: number;
    value: number;
    count?: number;
    avg?: number;
    p95?: number;
  }>;
  resolution: "raw" | "1h" | "1d";
}

export async function brainMetricsApi(params: {
  org_id: string;
  metric_key: string;
  project_id?: string;
  from: number;
  to: number;
  resolution?: "raw" | "1h" | "1d";
}): Promise<MetricSeries> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  return jsonFetch("GET", `/api/admin/brain/metrics?${qs.toString()}`);
}

export async function brainEventsApi(params: {
  org_id: string;
  table: "ingest_events" | "extractor_runs" | "hook_fires" | "brain_session_events";
  from?: number;
  to?: number;
  result?: string;
  session_id?: string;
  limit?: number;
}): Promise<{ items: Record<string, unknown>[]; total: number }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  return jsonFetch("GET", `/api/admin/brain/events?${qs.toString()}`);
}

export async function brainQueryLogsApi(params: {
  org_id: string;
  from?: number;
  to?: number;
  project_id?: string;
  limit?: number;
}): Promise<{
  items: Array<{
    query_id: string;
    ts: number;
    intent: string | null;
    latency_ms: number;
    confidence_score: number | null;
    project_id: string;
    query_spec_json: string;
  }>;
  total: number;
}> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) qs.set(k, String(v));
  }
  return jsonFetch("GET", `/api/admin/brain/query-logs?${qs.toString()}`);
}
