/**
 * NoSleep Brain MCP Server. Per-org via NOSLEEP_ORG_ID env var.
 * Exposes Phase 1 tools: search_archive, get_artifact, session_artifacts,
 * capture_url.  Phase 2 adds capture_thought + friends.
 *
 * HTTP-backed: forwards calls to the NoSleep brain API. Keeps this package
 * decoupled from brain schema and storage details.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  searchArchive,
  getArtifact,
  sessionArtifacts,
  captureUrl,
  ingestFileApi,
  captureThoughtApi,
  listThoughtsApi,
  searchThoughtsApi,
  unarchiveThoughtsApi,
  getThoughtApi,
  thoughtStatsApi,
  promoteArtifactApi,
  relatedThoughtsApi,
  addThoughtRefApi,
  listEntitiesApi,
  getEntityApi,
  brainMetricsApi,
  brainEventsApi,
  brainQueryLogsApi,
  type ThoughtDto,
  type RelatedThoughtDto,
} from "./client.js";

const ORG_ID = process.env.NOSLEEP_ORG_ID;
if (!ORG_ID) {
  console.error(
    "FATAL: NOSLEEP_ORG_ID is required. Brain MCP must be scoped to an organization.",
  );
  process.exit(1);
}

const server = new McpServer({
  name: `nosleep-brain-${ORG_ID}`,
  version: "0.1.0",
});

// ── search_archive ───────────────────────────────────────

server.tool(
  "search_archive",
  "Multi-modal structured search over captured archive artifacts. Pass a QuerySpec with text, facets, temporal, numeric filters. See docs/plans/brain/03-query-spec.md for shape. Returns ranked results with snippets.",
  {
    text_query: z.string().optional().describe("Free-text query (lexical + semantic hybrid)"),
    project_id: z.string().describe("Required project scope"),
    kind_prefix: z.array(z.string()).optional().describe("Filter to kinds matching these prefixes, e.g. ['decision/', 'code/diff']"),
    session_id: z.string().optional().describe("Filter to a specific session"),
    origin: z.string().optional().describe("Filter by tool that produced the artifact"),
    from_ts: z.number().int().optional().describe("Temporal range lower bound (unix seconds)"),
    to_ts: z.number().int().optional().describe("Temporal range upper bound (unix seconds)"),
    near_artifact: z.string().optional().describe("Rank by proximity in time to this artifact hash"),
    limit: z.number().int().min(1).max(200).default(20),
    return_score_breakdown: z.boolean().default(false),
  },
  async (args) => {
    const q: Record<string, unknown> = {
      org_id: ORG_ID,
      project_id: args.project_id,
      scope: "project",
      layers: ["archive"],
      limit: args.limit,
      return_score_breakdown: args.return_score_breakdown,
    };
    if (args.text_query) q.text = { query: args.text_query, mode: "hybrid", weight: 1.0 };
    if (args.near_artifact) {
      q.temporal = { near_artifact: args.near_artifact, weight: 0.5 };
    }
    if (args.from_ts !== undefined || args.to_ts !== undefined) {
      const t = (q.temporal as Record<string, unknown> | undefined) ?? {};
      if (args.from_ts !== undefined) t.from = args.from_ts;
      if (args.to_ts !== undefined) t.to = args.to_ts;
      q.temporal = t;
    }
    const facets: Record<string, unknown> = {};
    if (args.kind_prefix?.length) facets.kind_prefix = args.kind_prefix;
    if (args.session_id) facets.session_id = args.session_id;
    if (args.origin) facets.origin = args.origin;
    if (Object.keys(facets).length > 0) q.facets = facets;

    try {
      const res = await searchArchive(q);
      return {
        content: [
          {
            type: "text" as const,
            text: formatSearchResults(res),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: "text" as const, text: `search failed: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  },
);

// ── get_artifact ─────────────────────────────────────────

server.tool(
  "get_artifact",
  "Fetch full content of a single archive artifact by hash. Optionally include edges and the ingest event.",
  {
    hash: z.string().length(64).describe("SHA-256 hex of the artifact"),
    include_edges: z.boolean().default(false),
    include_ingest_event: z.boolean().default(false),
  },
  async (args) => {
    const include: string[] = [];
    if (args.include_edges) include.push("edges");
    if (args.include_ingest_event) include.push("ingest_event");
    try {
      const a = await getArtifact(args.hash, ORG_ID, include);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(a, null, 2) },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: "text" as const, text: `fetch failed: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  },
);

// ── session_artifacts ────────────────────────────────────

server.tool(
  "session_artifacts",
  "Chronological list of all artifacts captured for a session. Supports cursor pagination.",
  {
    session_id: z.string().describe("Session ID"),
    since: z.number().int().optional().describe("Only artifacts at or after this unix ts"),
    limit: z.number().int().min(1).max(500).default(100),
    cursor: z.string().optional().describe("Opaque cursor from previous response"),
    order: z.enum(["asc", "desc"]).default("asc"),
  },
  async (args) => {
    try {
      const res = await sessionArtifacts(args.session_id, ORG_ID, {
        since: args.since,
        limit: args.limit,
        cursor: args.cursor,
        order: args.order,
      });
      return {
        content: [
          { type: "text" as const, text: formatSessionArtifacts(res) },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: "text" as const, text: `fetch failed: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  },
);

// ── capture_url ──────────────────────────────────────────

server.tool(
  "capture_url",
  "Capture a URL as an archive reference. mode='ref' stores og-tag metadata only (fast). mode='full' is same as 'ref' in Phase 1; Phase 3 adds full content extraction. Optional note becomes a linked thought once Phase 2 ships.",
  {
    url: z.string().url(),
    project_id: z.string(),
    mode: z.enum(["ref", "full"]).default("full"),
    note: z.string().optional().describe("Optional note to attach (Phase 2)"),
    tags: z.array(z.string()).optional(),
  },
  async (args) => {
    try {
      const res = await captureUrl({
        url: args.url,
        org_id: ORG_ID,
        project_id: args.project_id,
        mode: args.mode,
        note: args.note,
        tags: args.tags,
      });
      return {
        content: [
          { type: "text" as const, text: formatCaptureResult(res) },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: "text" as const, text: `capture failed: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  },
);

// ── ingest_file ──────────────────────────────────────────

server.tool(
  "ingest_file",
  "Upload a document into the brain archive (PDF, Markdown/text, code, JSON/YAML/CSV, images) — the same pipeline as the web upload: dedup, full-text + semantic indexing, PDF page excerpts, and auto-distillation into a thought. Pass `path` (inside the project's directory; dotfiles refused) OR `content_base64` + `filename`. Max 10 MB.",
  {
    project_id: z.string().describe("Project to file the document under"),
    path: z.string().optional().describe("Local file path, absolute or relative to the project directory"),
    content_base64: z.string().optional().describe("Inline file bytes as base64 (instead of path)"),
    filename: z.string().optional().describe("File name incl. extension (required with content_base64; overrides the basename for path)"),
    content_type: z.string().optional().describe("MIME type override; inferred from the extension otherwise"),
  },
  async (args) => {
    try {
      const res = await ingestFileApi({ org_id: ORG_ID, ...args });
      const pages = res.page_count ? ` · ${res.page_count} page(s) extracted` : "";
      const warn = res.warnings.length ? `\nwarnings: ${res.warnings.join("; ")}` : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `${res.duplicate ? "Already in the brain (dedup hit — now linked to this project)" : "Ingested"}: ${res.filename} → ${res.kind} (${res.size} bytes)${pages}\nhash: ${res.hash}${warn}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `ingest_file failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ── Formatting helpers ───────────────────────────────────

function formatSearchResults(res: Awaited<ReturnType<typeof searchArchive>>): string {
  if (res.results.length === 0) {
    return `No results. (${res.total_candidates} candidates scanned in ${res.latency_ms.toFixed(1)}ms)`;
  }
  const lines = [
    `Found ${res.results.length} result(s) in ${res.latency_ms.toFixed(1)}ms:`,
    "",
  ];
  for (const [i, r] of res.results.entries()) {
    lines.push(
      `${i + 1}. [${r.kind}] ${new Date(r.ts * 1000).toISOString()}`,
      `   hash: ${r.hash}`,
      `   project: ${r.project_id}${r.session_id ? ` · session: ${r.session_id}` : ""}`,
      `   score: ${r.score.toFixed(4)} (rank ${r.fused_rank})`,
      `   ${r.snippet}`,
      "",
    );
  }
  return lines.join("\n");
}

function formatSessionArtifacts(
  res: Awaited<ReturnType<typeof sessionArtifacts>>,
): string {
  if (res.items.length === 0) return "No artifacts in this session.";
  const lines = [`${res.items.length} artifact(s) in session ${res.session_id}:`, ""];
  for (const a of res.items) {
    lines.push(
      `- [${a.kind}] ${new Date(a.ts * 1000).toISOString()} (hash: ${a.hash.slice(0, 12)}…)`,
      `  ${a.snippet ?? "(no text)"}`,
      "",
    );
  }
  if (res.cursor) lines.push(`next cursor: ${res.cursor}`);
  return lines.join("\n");
}

function formatCaptureResult(res: Awaited<ReturnType<typeof captureUrl>>): string {
  if (res.error) return `Captured with error: ${res.error}\nhash: ${res.link_hash}`;
  return [
    `Captured ${res.normalized_url}`,
    `hash: ${res.link_hash}`,
    res.title ? `title: ${res.title}` : null,
    res.og_image ? `og:image: ${res.og_image}` : null,
    `status: ${res.status}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Thoughts tools ───────────────────────────────────────

const THOUGHT_TYPES = [
  "observation",
  "task",
  "idea",
  "reference",
  "person_note",
  "decision",
  "insight",
  "question",
] as const;

server.tool(
  "capture_thought",
  "Save a thought to the brain for the current project. Metadata (type, topics, people, action_items, dates_mentioned) is extracted async — the return may include similar existing thoughts for dedup awareness.",
  {
    content: z.string().min(1).describe("Standalone self-contained thought content"),
    project_id: z.string().describe("Required project scope"),
    source_refs: z
      .array(z.object({ hash: z.string().length(64), relation: z.string() }))
      .optional()
      .describe("Optional archive artifact refs"),
    thought_type_hint: z.enum(THOUGHT_TYPES).optional(),
    strategy_node_ref: z.string().optional(),
  },
  async (args) => {
    try {
      const res = await captureThoughtApi({
        content: args.content,
        org_id: ORG_ID,
        project_id: args.project_id,
        source_kind: "mcp_capture",
        // The MCP SDK's zod inference types array-object fields as
        // all-optional; narrow back to the required shape it validated.
        source_refs: args.source_refs?.filter(
          (r): r is { hash: string; relation: string } =>
            typeof r.hash === "string" && typeof r.relation === "string",
        ),
        thought_type_hint: args.thought_type_hint,
        strategy_node_ref: args.strategy_node_ref,
      });
      const lines = [`Captured thought ${res.id}`];
      if (res.similar_existing.length > 0) {
        lines.push("", "Similar existing thoughts:");
        for (const s of res.similar_existing) {
          lines.push(`  - ${s.id}: ${s.snippet}`);
        }
      }
      lines.push("", `Extractors enqueued: ${res.enqueued_extractors.join(", ")}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `capture failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "search_thoughts",
  "Lexical search over captured thoughts (Phase 3 will add semantic). Returns top matches with metadata.",
  {
    query: z.string().min(1),
    project_id: z.string(),
    limit: z.number().int().min(1).max(100).default(10),
    scope: z.enum(["project", "org"]).default("project"),
    include_archived: z
      .boolean()
      .default(false)
      .describe("Also search thoughts the nightly consolidator soft-archived (stale or superseded)."),
  },
  async (args) => {
    try {
      const res = await searchThoughtsApi({
        org_id: ORG_ID,
        project_id: args.project_id,
        query: args.query,
        limit: args.limit,
        scope: args.scope,
        include_archived: args.include_archived,
      });
      return { content: [{ type: "text" as const, text: formatThoughtSearch(res.results) }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `search failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "list_thoughts",
  "List recent thoughts with optional filters.",
  {
    project_id: z.string(),
    type: z.enum(THOUGHT_TYPES).optional(),
    topic: z.string().optional(),
    person: z.string().optional(),
    days: z.number().int().min(1).max(3650).optional(),
    limit: z.number().int().min(1).max(500).default(20),
    include_archived: z.boolean().default(false),
  },
  async (args) => {
    try {
      const res = await listThoughtsApi({
        org_id: ORG_ID,
        project_id: args.project_id,
        type: args.type,
        topic: args.topic,
        person: args.person,
        days: args.days,
        limit: args.limit,
        include_archived: args.include_archived,
      });
      return { content: [{ type: "text" as const, text: formatThoughtList(res.items) }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `list failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "unarchive_thoughts",
  "Restore thoughts the nightly sleep-time consolidator soft-archived (visibility 'archived'). Pins them by default so the next sweep keeps them.",
  {
    ids: z.array(z.string().min(1)).min(1).max(1000),
    pin: z.boolean().default(true),
  },
  async (args) => {
    try {
      const res = await unarchiveThoughtsApi({ org_id: ORG_ID, ids: args.ids, pin: args.pin });
      const lines = [`restored ${res.restored.length} thought(s)`];
      if (res.not_archived.length) lines.push(`not archived / not found: ${res.not_archived.join(", ")}`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `unarchive failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "thought_stats",
  "Aggregated statistics: counts by type, top topics, top people.",
  {
    project_id: z.string(),
    scope: z.enum(["project", "org"]).default("project"),
  },
  async (args) => {
    try {
      const s = await thoughtStatsApi({
        org_id: ORG_ID,
        project_id: args.project_id,
        scope: args.scope,
      });
      return { content: [{ type: "text" as const, text: formatStats(s) }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `stats failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "get_thought",
  "Fetch a single thought with optional refs (archive_refs, thought_refs, entity_refs).",
  {
    id: z.string(),
    include: z
      .array(z.enum(["archive_refs", "thought_refs", "entity_refs", "refs"]))
      .optional(),
  },
  async (args) => {
    try {
      const t = await getThoughtApi(args.id, ORG_ID, args.include ?? []);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(t, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `fetch failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "promote_artifact",
  "Promote an archive artifact into a thought. Creates a thought with `distilled_from` bridge to the source artifact.",
  {
    archive_hash: z.string().length(64),
    project_id: z.string(),
    thought_type_hint: z.enum(THOUGHT_TYPES).optional(),
    relation: z.string().optional(),
  },
  async (args) => {
    try {
      const res = await promoteArtifactApi({
        archive_hash: args.archive_hash,
        org_id: ORG_ID,
        project_id: args.project_id,
        thought_type_hint: args.thought_type_hint,
        relation: args.relation,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Promoted to thought ${res.id} (enqueued: ${res.enqueued_extractors.join(", ")})`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `promote failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

function formatThoughtSearch(
  results: Array<{ thought: ThoughtDto; relevance: number; snippet: string }>,
): string {
  if (results.length === 0) return "No matching thoughts.";
  const lines = [`Found ${results.length} thought(s):`, ""];
  for (const [i, r] of results.entries()) {
    lines.push(
      `${i + 1}. [${r.thought.thought_type ?? "?"}] ${new Date(r.thought.created_at * 1000).toISOString()}`,
      `   id: ${r.thought.id}`,
      `   relevance: ${r.relevance.toFixed(4)}`,
    );
    if (r.thought.metadata.topics.length)
      lines.push(`   topics: ${r.thought.metadata.topics.join(", ")}`);
    if (r.thought.metadata.people.length)
      lines.push(`   people: ${r.thought.metadata.people.join(", ")}`);
    lines.push(`   ${r.snippet}`, "");
  }
  return lines.join("\n");
}

function formatThoughtList(items: ThoughtDto[]): string {
  if (items.length === 0) return "No thoughts.";
  const lines = [`${items.length} thought(s):`, ""];
  for (const t of items) {
    const tags = t.metadata.topics.length ? ` [${t.metadata.topics.join(", ")}]` : "";
    lines.push(
      `- [${new Date(t.created_at * 1000).toLocaleDateString()}] (${t.thought_type ?? "?"}${tags})`,
      `  ${t.content.slice(0, 160)}${t.content.length > 160 ? "…" : ""}`,
      "",
    );
  }
  return lines.join("\n");
}

function formatStats(s: {
  total: number;
  date_range: { first: number | null; last: number | null };
  types: Array<{ type: string; count: number }>;
  top_topics: Array<{ topic: string; count: number }>;
  top_people: Array<{ person: string; count: number }>;
}): string {
  const lines: string[] = [`Total thoughts: ${s.total}`];
  if (s.date_range.first && s.date_range.last) {
    lines.push(
      `Date range: ${new Date(s.date_range.first * 1000).toLocaleDateString()} → ${new Date(s.date_range.last * 1000).toLocaleDateString()}`,
    );
  }
  lines.push("", "Types:");
  for (const t of s.types) lines.push(`  ${t.type}: ${t.count}`);
  if (s.top_topics.length) {
    lines.push("", "Top topics:");
    for (const t of s.top_topics) lines.push(`  ${t.topic}: ${t.count}`);
  }
  if (s.top_people.length) {
    lines.push("", "People mentioned:");
    for (const p of s.top_people) lines.push(`  ${p.person}: ${p.count}`);
  }
  return lines.join("\n");
}

// ── Phase 4: related_thoughts + thought_refs + entities ─

const RELATED_MODALITIES = [
  "edges",
  "entities",
  "shared_session",
  "topics",
] as const;

const THOUGHT_REF_RELATIONS = [
  "refines",
  "supersedes",
  "contradicts",
  "continues",
  "related_to",
  "duplicate_of",
  "answers",
  "asks_about",
  "derives_from_thought",
] as const;

const ENTITY_KINDS = [
  "person",
  "topic",
  "concept",
  "external_project",
  "tool",
  "agent",
  "place",
] as const;

server.tool(
  "related_thoughts",
  "Find thoughts related to a given thought via explicit edges, shared entities, shared sessions, or shared topics.",
  {
    id: z.string().describe("Source thought id"),
    modalities: z.array(z.enum(RELATED_MODALITIES)).optional(),
    limit: z.number().int().min(1).max(100).default(10),
  },
  async (args) => {
    try {
      const res = await relatedThoughtsApi(args.id, ORG_ID, {
        modalities: args.modalities,
        limit: args.limit,
      });
      return {
        content: [{ type: "text" as const, text: formatRelated(res.items) }],
      };
    } catch (err) {
      return {
        content: [
          { type: "text" as const, text: `related failed: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "link_thoughts",
  "Create a typed edge (thought_ref) between two thoughts. Relations: refines, supersedes, contradicts, continues, related_to, duplicate_of, answers, asks_about, derives_from_thought.",
  {
    from_thought_id: z.string(),
    to_thought_id: z.string(),
    relation: z.enum(THOUGHT_REF_RELATIONS),
  },
  async (args) => {
    try {
      const res = await addThoughtRefApi({
        org_id: ORG_ID,
        from_thought_id: args.from_thought_id,
        to_thought_id: args.to_thought_id,
        relation: args.relation,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: res.created
              ? `Linked ${args.from_thought_id} → ${args.to_thought_id} [${args.relation}] (${res.scope})`
              : `Link already exists.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          { type: "text" as const, text: `link failed: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "list_entities",
  "List entities (people, topics, concepts, etc.) in the org, ranked by frequency.",
  {
    project_id: z.string().optional().describe("If omitted, ranks across the whole org"),
    kind: z.enum(ENTITY_KINDS).optional(),
    order: z.enum(["frequency", "recent", "alpha"]).default("frequency"),
    limit: z.number().int().min(1).max(500).default(50),
  },
  async (args) => {
    try {
      const res = await listEntitiesApi({
        org_id: ORG_ID,
        project_id: args.project_id,
        kind: args.kind,
        order: args.order,
        limit: args.limit,
      });
      return {
        content: [{ type: "text" as const, text: formatEntities(res.items) }],
      };
    } catch (err) {
      return {
        content: [
          { type: "text" as const, text: `list failed: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  "get_entity",
  "Fetch entity hub: canonical name, aliases, ref count, recent mentions, related entities.",
  { id: z.string() },
  async (args) => {
    try {
      const e = await getEntityApi(args.id, ORG_ID);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(e, null, 2) }],
      };
    } catch (err) {
      return {
        content: [
          { type: "text" as const, text: `fetch failed: ${(err as Error).message}` },
        ],
        isError: true,
      };
    }
  },
);

function formatRelated(items: RelatedThoughtDto[]): string {
  if (items.length === 0) return "No related thoughts.";
  const lines = [`${items.length} related thought(s):`, ""];
  for (const [i, r] of items.entries()) {
    lines.push(
      `${i + 1}. [${r.thought.thought_type ?? "?"}] score=${r.score.toFixed(2)} id=${r.thought.id}`,
      `   ${r.thought.content.slice(0, 160)}${r.thought.content.length > 160 ? "…" : ""}`,
      `   signals: ${r.signals
        .map((s) => `${s.modality}:${s.detail}`)
        .join(", ")}`,
      "",
    );
  }
  return lines.join("\n");
}

function formatEntities(items: Array<{ canonical_name: string; kind: string; ref_count: number; id: string }>): string {
  if (items.length === 0) return "No entities.";
  const lines = [`${items.length} entit${items.length === 1 ? "y" : "ies"}:`, ""];
  for (const e of items) {
    lines.push(`- [${e.kind}] ${e.canonical_name} (${e.ref_count} refs · id: ${e.id})`);
  }
  return lines.join("\n");
}

// ── Phase 7: observability tools ─────────────────────────

server.tool(
  "brain_metrics",
  "Fetch a brain metric timeseries. Common keys: artifacts.ingested.count, query.latency_ms, hook.latency_ms, tokens.total, cost.usd. Resolution auto-selected by range; pass 'raw' | '1h' | '1d' to override.",
  {
    metric_key: z.string(),
    project_id: z.string().optional(),
    from: z.number().int().describe("Unix seconds"),
    to: z.number().int().describe("Unix seconds"),
    resolution: z.enum(["raw", "1h", "1d"]).optional(),
  },
  async (args) => {
    try {
      const res = await brainMetricsApi({
        org_id: ORG_ID,
        metric_key: args.metric_key,
        project_id: args.project_id,
        from: args.from,
        to: args.to,
        resolution: args.resolution,
      });
      const summary = res.points
        .slice(-20)
        .map((p) => `${new Date(p.ts * 1000).toISOString()}  ${p.value.toFixed(2)}`)
        .join("\n");
      return {
        content: [
          {
            type: "text" as const,
            text: `${args.metric_key} (${res.resolution}, ${res.points.length} points)\n\n${summary || "(no data)"}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `metrics failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "brain_events",
  "Fetch audit events from one of: ingest_events, extractor_runs, hook_fires, brain_session_events. Optional filters: from/to (unix sec), result, session_id, limit.",
  {
    table: z.enum([
      "ingest_events",
      "extractor_runs",
      "hook_fires",
      "brain_session_events",
    ]),
    from: z.number().int().optional(),
    to: z.number().int().optional(),
    result: z.string().optional(),
    session_id: z.string().optional(),
    limit: z.number().int().min(1).max(500).default(50),
  },
  async (args) => {
    try {
      const res = await brainEventsApi({
        org_id: ORG_ID,
        table: args.table,
        from: args.from,
        to: args.to,
        result: args.result,
        session_id: args.session_id,
        limit: args.limit,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `${res.total} ${args.table} row(s):\n\n${JSON.stringify(res.items.slice(0, 30), null, 2)}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `events failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "brain_query_logs",
  "Fetch your own query history with timing, intent, confidence — useful for debugging retrieval misses.",
  {
    from: z.number().int().optional(),
    to: z.number().int().optional(),
    project_id: z.string().optional(),
    limit: z.number().int().min(1).max(500).default(50),
  },
  async (args) => {
    try {
      const res = await brainQueryLogsApi({
        org_id: ORG_ID,
        from: args.from,
        to: args.to,
        project_id: args.project_id,
        limit: args.limit,
      });
      const formatted = res.items
        .slice(0, 30)
        .map((q) => {
          const summary = (() => {
            try {
              const p = JSON.parse(q.query_spec_json) as {
                text?: { query?: string };
              };
              return p.text?.query ?? "(no text query)";
            } catch {
              return "?";
            }
          })();
          return `[${new Date(q.ts * 1000).toISOString()}] ${q.intent ?? "—"} ${q.latency_ms?.toFixed(1)}ms conf=${q.confidence_score?.toFixed(2) ?? "—"} : ${summary}`;
        })
        .join("\n");
      return {
        content: [
          {
            type: "text" as const,
            text: `${res.total} query log(s):\n\n${formatted || "(no queries logged)"}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `query_logs failed: ${(err as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ── Boot ─────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`nosleep-brain-${ORG_ID} MCP server ready`);
