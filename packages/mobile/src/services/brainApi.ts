/**
 * Brain API client for mobile. Kept separate from the existing api.ts so we
 * don't fight the camelCase transform on brain's raw JSON responses.
 */

import { getServerConfig } from "../config";

async function jsonFetch<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const cfg = await getServerConfig();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cfg.apiKey) headers["x-api-key"] = cfg.apiKey;
  const res = await fetch(`${cfg.apiUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export interface BrainThought {
  id: string;
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
  created_at: number;
  updated_at: number;
}

export interface CaptureThoughtRequest {
  content: string;
  org_id: string;
  project_id: string;
  source_kind?: string;
  thought_type_hint?: string;
  source_refs?: Array<{ hash: string; relation: string }>;
  strategy_node_ref?: string;
}

export interface CaptureThoughtResult {
  id: string;
  enqueued_extractors: string[];
  similar_existing: Array<{ id: string; content: string; snippet: string }>;
}

export async function captureThought(
  req: CaptureThoughtRequest,
): Promise<CaptureThoughtResult> {
  return jsonFetch("POST", "/api/brain/thoughts", req);
}

export async function listThoughts(params: {
  org_id: string;
  project_id: string;
  type?: string;
  days?: number;
  limit?: number;
}): Promise<{ items: BrainThought[] }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  return jsonFetch("GET", `/api/brain/thoughts?${qs.toString()}`);
}

// ── Phase 5-finish: photo upload + sessions/artifacts/images ─

export interface IngestResult {
  hash: string;
  duplicate: boolean;
  enqueued: string[];
  size: number;
  latency_ms: number;
}

export async function ingestImage(args: {
  base64: string;
  content_type: string;
  org_id: string;
  project_id: string;
  width?: number;
  height?: number;
}): Promise<IngestResult> {
  return jsonFetch("POST", "/api/brain/ingest", {
    kind: "media/image/photo",
    content: args.base64,
    content_type: args.content_type,
    org_id: args.org_id,
    project_id: args.project_id,
    origin: { tool: "nosleep-mobile", actor: "user" },
    kind_specific_meta: {
      width: args.width,
      height: args.height,
    },
    schema_version: 1,
  });
}

export async function ingestAudio(args: {
  base64: string;
  content_type: string; // "audio/mp4" (m4a) on iOS, "audio/webm" on web etc.
  org_id: string;
  project_id: string;
  duration_ms?: number;
  transcript?: string; // bundled transcript for replay convenience
}): Promise<IngestResult> {
  return jsonFetch("POST", "/api/brain/ingest", {
    kind: "conversation/voice_note/recording",
    content: args.base64,
    content_type: args.content_type,
    org_id: args.org_id,
    project_id: args.project_id,
    origin: { tool: "nosleep-mobile", actor: "user" },
    kind_specific_meta: {
      duration_ms: args.duration_ms,
      transcript: args.transcript,
    },
    schema_version: 1,
  });
}

export interface BrainSessionArtifactItem {
  hash: string;
  kind: string;
  ts: number;
  turn_ord: number | null;
  origin_tool: string;
  actor: string | null;
  size: number;
  snippet: string | null;
  kind_specific_meta: unknown;
}

export async function getSessionArtifacts(
  sessionId: string,
  orgId: string,
  opts: { limit?: number; cursor?: string; order?: "asc" | "desc" } = {},
): Promise<{ session_id: string; items: BrainSessionArtifactItem[]; cursor: string | null }> {
  const qs = new URLSearchParams({ org_id: orgId });
  if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
  if (opts.cursor) qs.set("cursor", opts.cursor);
  if (opts.order) qs.set("order", opts.order);
  return jsonFetch("GET", `/api/brain/sessions/${encodeURIComponent(sessionId)}/artifacts?${qs.toString()}`);
}

export interface BrainArtifact {
  hash: string;
  kind: string;
  ts: number;
  org_id: string;
  project_id: string;
  session_id: string | null;
  origin: { tool: string; version: string | null; actor: string | null };
  content: string | null;
  content_encoding: "base64" | "utf8";
  content_type: string | null;
  size: number;
  kind_specific_meta: unknown;
}

export async function getArtifact(
  hash: string,
  orgId: string,
): Promise<BrainArtifact> {
  const qs = new URLSearchParams({ org_id: orgId });
  return jsonFetch("GET", `/api/brain/artifacts/${hash}?${qs.toString()}`);
}

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

export async function listImages(params: {
  org_id: string;
  project_id: string;
  scene_class?: string;
  limit?: number;
}): Promise<{ items: BrainImageItem[] }> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") qs.set(k, String(v));
  }
  return jsonFetch("GET", `/api/brain/images?${qs.toString()}`);
}

// ── Phase 9: search ────────────────────────────────────

export interface BrainSearchResult {
  hash: string;
  kind: string;
  ts: number;
  project_id: string;
  session_id: string | null;
  snippet: string;
  score: number;
  fused_rank: number;
}

export interface BrainSearchResponse {
  query_id: string;
  latency_ms: number;
  total_candidates: number;
  results: BrainSearchResult[];
  layers_returned: { archive: number; thoughts: number };
  files_queried?: string[];
}

export interface BrainSearchSpec {
  org_id: string;
  project_id: string;
  scope?: "project" | "org";
  text?: { query: string; mode?: "lexical" | "semantic" | "hybrid" };
  facets?: { kind_prefix?: string[] };
  temporal?: { from?: number; to?: number };
  time_range?: "recent" | "all_time";
  limit?: number;
}

export async function brainSearch(spec: BrainSearchSpec): Promise<BrainSearchResponse> {
  return jsonFetch("POST", "/api/brain/search", spec);
}
