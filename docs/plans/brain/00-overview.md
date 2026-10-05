# NoSleep Brain — Design Overview

> Master spec for the two-layer knowledge system layered onto NoSleep. Every load-bearing decision from the design discussion is captured here. Subsequent docs expand specific areas (schema, taxonomy, QuerySpec, MCP/API, per-phase plans).

## Why

NoSleep orchestrates Claude Code sessions autonomously. Over months, a single org produces millions of artifacts (turns, diffs, images, commands). Two problems:

1. **Receipts** — "we decided X" needs to resolve to the actual conversation, the actual diff, the actual error screenshot. Raw history must be queryable, not just summarized.
2. **Attention** — nobody reads millions of artifacts linearly. High-signal items (decisions, insights, action items) need a sparse curated layer you can navigate.

The brain solves both by running two cooperating layers simultaneously.

## Two layers

| | **Layer 1: Archive (full capture)** | **Layer 2: Thoughts (distillation)** |
|---|---|---|
| What | Every turn, tool call, tool result, image, diff, file snapshot, command output, extended thinking | Curated notes, decisions, insights, ACT-NOW items, session summaries, captured URLs |
| Triggered by | Harness hooks (mechanical) | Intentional: user capture, auto-capture skill, explicit `promote_artifact` |
| Volume | ~500 artifacts/session × 11K sessions/yr/org = millions/yr | ~5–20 thoughts/session |
| Who decides | Nobody — always on | Agent or user |
| Storage | `artifacts` + kind-specific feature tables, sealed quarterly | `thoughts` table |
| Retrieval | Multi-modal QuerySpec (14 modalities) | Nate's 4 tools + our extensions |
| Source of truth for | "What actually happened, in full" | "What's worth remembering, curated" |

**Archive is memory. Thoughts are attention.** The brain is the pair.

Layer 2's distillation pattern comes directly from Nate B's Open Brain (`future-elle/open-brain-natebjones`): flat `thoughts` table + LLM metadata extraction (`type`, `topics`, `people`, `action_items`, `dates_mentioned`) + four MCP tools. Layer 1 is non-skill-dependent: hooks fire and the server ingests regardless of agent behavior.

## Storage — single engine, per-org, sealed quarterly

- **Per-org directory**: `data/brain/<org_id>/` — hard org boundary at the filesystem level.
- **Inside each org directory**:
  - `active.db` — current quarter, writable, WAL mode.
  - `sealed-YYYY-QN.db` — immutable once sealed. Each holds its own blobs, FTS5 index, sqlite-vec vectors, kind-specific feature tables, and (Phase 8+) inline HNSW index.
  - `catalog.db` — small mutable companion: project visibility, sealed-file metadata, file-to-project mapping for smart query routing. Rebuildable from sealed files.
- **One storage engine**: SQLite + `sqlite-vec` + FTS5 + R-Tree + kind-specific metadata tables. No split engines. No ChromaDB. No separate vector DB. This keeps the **unit of integrity** equal to one file.
- **Quarterly seal**: 20 sealed + 1 active = 21 files per org over 5 years hot. Corruption of one file loses one quarter, never the whole org.
- **Compression**: zstd per-blob, plus **zstd dictionaries trained at seal time on the quarter's content**. Typical 5–10× compression over plain zstd for conversational/tool-output-heavy workloads.
- **Retention**: 5-year hot (all files online, ATTACH-able). After 5 years: drop raw metric points, keep 1h rollups 5yr, keep 1d rollups indefinitely. Sealed files beyond 5yr stay unless explicitly archived cold.

## Append-only, enforced

- Archive tables use BEFORE-DELETE and BEFORE-UPDATE triggers that `RAISE(ABORT)`. Enforced at SQLite level, not by convention.
- No `deleted_at` column. The word "delete" does not appear in archive schema.
- **Soft-delete = project-level quarantine** via `projects.visibility ∈ {active, hidden, archived_noise}` in `catalog.db`. Default queries filter `visibility='active'`. Data is never removed — only hidden from retrieval.
- Updates-in-spirit happen by inserting a new artifact with a `supersedes` edge to the old.
- **Legal erasure escape hatch**: separate high-ceremony path rewrites the affected sealed file minus the tombstoned hash, archives the old file offline, rotates hash in `catalog.db`. Rare, auditable.

## Retrieval — N orthogonal modalities

Each modality has its own index and its own scoring. "FTS + vector + filters" under-serves this corpus.

| Modality | Index | Backend |
|---|---|---|
| Lexical | FTS5 + BM25 | `artifacts_fts` |
| Semantic (text) | dense vectors 1024-dim | `sqlite-vec` + per-file HNSW (Phase 8) |
| Exact content | PK on `hash` | B-tree |
| Relational/facet | B-tree on columns | SQLite native |
| Temporal point | B-tree on `ts` | native |
| Temporal interval | R-Tree | `CREATE VIRTUAL TABLE validity USING rtree(id, valid_from, valid_to)` |
| Proximity/session | composite `(session_id, turn_ord)` | native |
| Graph | adjacency + nightly PPR cache | `artifact_edges` + `ppr_scores` |
| Perceptual (image) | 64-bit pHash + BK-tree | `image_features` |
| Semantic (image) | CLIP 512-dim | `vec_clip` |
| Code-structural | tree-sitter AST symbols | `code_symbols` |
| Numeric/range | B-tree on numeric metadata | `artifact_num_meta` |
| Provenance/causal | edge traversal via `produced_by` relation | `artifact_edges` |
| Authorship/actor | B-tree on `origin/actor` | native |

### Query shape

Queries are **structured `QuerySpec` objects**, not strings. Facets and numeric filters are HARD filters (applied as SQL WHERE before ranking). Text, image, temporal, graph are **ranked retrievers**. See `03-query-spec.md` for full shape.

### Pipeline

1. Hard filters (facet + numeric + scope) narrow candidate pool.
2. Ranked retrievers run in parallel, each returning top-K with scores.
3. **RRF fusion** combines ranked lists: `score(d) = Σ w_m · 1/(k + rank_m(d))`, k=60, layer + intent weights.
4. **Dedup** via simhash, **MMR diversification** λ=0.5.
5. **Cross-encoder rerank** (bge-reranker-v2-m3, Phase 3+) on top-100 → top-20, always-on.
6. **Optional LLM rerank** (Haiku, Phase 9+) confidence-gated on top-20 → top-5.
7. **Confidence floor**: if top fused score < τ, return "low confidence" response rather than lie.

### Intent-driven priors

Tiny intent classifier (rules-first, small LLM fallback) routes query to per-retriever weights and per-layer priors:

- `find_decisions` → thoughts 0.7, archive 0.3; boost `decision/*`, `knowledge/insight`
- `recall_conversation` → archive 0.8, thoughts 0.2; lean FTS over vector
- `debug_session` → archive 0.9, thoughts 0.1; boost `process/error_trace`, `code/test_result`
- `find_code` → archive-only; boost `code/*`; code-structural retriever dominates
- `visual_recall` → archive; boost `media/image/*`; perceptual + semantic-image dominate

## Cross-reference as first-class

Three append-only edge tables plus an entity resolution layer.

1. **`artifact_edges`** — archive ↔ archive; mechanical at ingest. Relations: `turn_read_file`, `turn_wrote_diff`, `turn_invoked_tool`, `turn_produced_image`, `produced_by`, `supersedes`, `link_resolved_to_fetch`, etc.
2. **`thought_refs`** — thought ↔ thought. Relations: `refines`, `supersedes`, `contradicts`, `continues`, `related_to`, `duplicate_of`, `answers`, `asks_about`. Manual in v1; LLM-suggested proposer gated for Phase 10+.
3. **`thought_archive_refs`** — thought ↔ archive (bridge). Relations: `distilled_from`, `quoted`, `summarizes`, `action_item_from`, `decided_in`, `references`, `refutes`, `triggered_by`.

All three trigger-enforced append-only. Cross-project edges within an org allowed (`scope='cross_project'`); **cross-org edges forbidden** and rejected at insert.

### Entities (people, topics, concepts, tools, agents, external projects)

Promoted from Nate's metadata strings to first-class nodes:

- `entities(id, org_id, kind, canonical_name, aliases_json, metadata_json, ...)` with kind ∈ {person, topic, concept, external_project, tool, agent, place}
- `entity_refs(entity_id, referrer_kind, referrer_id, project_id, relation)` — either thought or artifact refers to entity
- **Entity resolver** async worker runs after metadata extraction: matches strings against canonical + aliases, creates new entities when unknown, records refs.
- Entity merge via lazy `entities.merged_into` column — no row rewrites, reversible, queries resolve through the redirect.
- Unlocks cross-project discovery without weakening the org boundary ("show me everything about Jane across this org").

## Project scoping

`project_id` is NOT NULL on every artifact, every edge, every thought, every entity_ref. Sentinel `_org_level` covers org-scoped items (no nullable project columns — saves a million null-checks).

- Default query scope is **project**, not org. `scope='org'` flag required to fan wider.
- MCP tools require `project_id` on reads; writes always project-scoped.
- Storage stays time-partitioned at org level, not project (SQLite `ATTACH DATABASE` limit of 125 would break at 30 projects × 60 months).

## Capture modalities

Ingestion hits the same pipeline regardless of source:

| Source | Path | Layer |
|---|---|---|
| Claude Code hooks | Hook → HTTP callback → `/api/brain/ingest` | Layer 1 |
| OpenCode webhook (Phase 10) | Webhook → `/api/brain/ingest` | Layer 1 |
| User mobile note | Mobile Capture tab → `POST /api/brain/thoughts` | Layer 2 (+ attached media → Layer 1) |
| User web capture | `/brain/capture-url` or modal → `POST /api/brain/*` | Layer 1 + 2 |
| URL/reference capture | `POST /api/brain/capture-url` with `mode ∈ {ref, full}` | Layer 1 (fetched content) + Layer 2 (optional note) |
| Agent MCP call | MCP `capture_thought` or direct ingest tool | Layer 2 (or Layer 1) |
| Auto-capture skill | Agent invokes `capture_thought` at session close | Layer 2 |
| Retroactive backfill (Phase 10) | One-shot migration script | Layer 1 |

**Ingestion contract is versioned.** Additive changes preferred. Breaking changes require migration that writes a translated-metadata sidecar and never mutates the original hash.

### URL/reference capture

First-class modality. Two modes:

- **`ref`** — lightweight bookmark. Creates `reference/link(normalized_url, title, description, og_image)`. Minimal processing.
- **`full`** — fetch + Readability → markdown extraction, inline images fetched as `media/image/*`, metadata LLM extract, embedding. Creates `reference/link` + `document/web_fetch` linked by `link_resolved_to_fetch` edge.

Content-type-aware fetcher: HTML (Readability), PDF (pdf-parse → `document/pdf_excerpt` per page), image (direct `media/image/*`), JSON/text/markdown (verbatim), YouTube/Vimeo (metadata + transcript, no video download). Link hash = normalized URL SHA. Fetch hash = body SHA. Page-change supersede edges.

## Extractor fan-out

Every artifact triggers a fan-out of async extractors. Synchronous ingest writes only blob + skeleton row + known edges + enqueue jobs (~3–5 ms). Extractors race behind the queue.

| Extractor | When it runs | Writes to |
|---|---|---|
| `metadata_llm` | All thought artifacts; some archive kinds (assistant messages, user messages) | `thoughts.metadata_json`, `artifact_num_meta` |
| `embedding_text` | Allowlisted kinds only (see embed allowlist) | `vec_text` |
| `phash` | `media/image/*` | `image_features.phash` |
| `clip` | `media/image/*` | `vec_clip` |
| `ocr` | `media/image/*` (if scene_class ∈ {ui, terminal, diagram}) | `image_features.ocr_text` |
| `caption` | `media/image/*` | `image_features.caption` |
| `exif` | `media/image/*` | `image_features.exif_json` |
| `scene_classify` | `media/image/*` | `image_features.scene_class` |
| `ast` | `code/*` | `code_symbols` |
| `entity_resolver` | After `metadata_llm` completes | `entities`, `entity_refs` |
| `url_fetcher` | `reference/link` with mode=full | `document/web_fetch` + linked artifacts |
| `ppr_refresh` | Nightly batch | `ppr_scores` |

### Embed allowlist (per-project override, org default)

Selective embedding drops 5-year per-org vector volume from ~12M to ~3M. Default ON:

- `conversation/turn/user_message`, `conversation/turn/assistant_message`, `conversation/turn/thought`
- `code/blob`, `code/diff`
- `knowledge/*`, `decision/*`
- `document/web_fetch`, `document/markdown`, `document/pdf_excerpt`

Default OFF: `conversation/tool_result`, `process/command_output`, `process/log_line`, raw `media/*` (images embed via CLIP separately, not text-embedding pipeline). Per-project override in config UI.

## Timeseries + events

Numerical timeseries and audit events are their own first-class storage, not shoehorned into `artifacts`.

- **`metrics`** (raw) + **`metrics_rollup_1h`** + **`metrics_rollup_1d`** — canonical metric-key namespace locked (`tokens.*`, `cost.*`, `artifacts.*`, `extractor.*`, `hook.*`, `sessions.*`, `validation.*`, `supervision.*`, `query.*`, `budget.*`, `system.*`, `storage.*`). No free-form tag keys. Seal with quarter.
- **Event tables** — `ingest_events`, `extractor_runs`, `hook_fires`, `query_logs`, `session_events`. All append-only. Rolled up into metrics where scalar-counterable.
- Unified with existing NoSleep `system-stats`, `budget-pacer`, supervision loop, `alerts` — those all feed into this, not separate stores.

## UI surfaces

### Web (React + Vite + Tailwind, under existing NoSleep dashboard)

Routes under `/brain` and `/admin/brain`:

| Route | Purpose |
|---|---|
| `/brain` | D3 force-directed graph (thoughts + entities default; archive toggle off) |
| `/brain/search` | Structured QuerySpec builder + results |
| `/brain/thoughts` | Flat thought browser (virtualized) |
| `/brain/archive` | Flat archive browser (virtualized) |
| `/brain/timeline` | Chronological feed of artifacts |
| `/brain/images` | Gallery with pHash clustering + OCR search |
| `/brain/code` | Code-centric: symbols, file history, diff lineage |
| `/brain/commands` | Command log viewer |
| `/brain/references` | Reference/link viewer grouped by domain |
| `/brain/compare` | Two-artifact side-by-side |
| `/brain/session/:id` | Full session replay with jump-to toolbar + derived thoughts |
| `/brain/thought/:id` | Thought detail + refs + archive back-trace |
| `/brain/artifact/:hash` | Kind-aware artifact renderer |
| `/brain/entity/:id` | Entity hub: mentions, related entities, aliases, history |
| `/brain/capture-url` | URL capture form (modal triggerable by Cmd-U anywhere) |
| `/brain/project/:id/metrics` | Per-project metric dashboard |
| `/admin/brain` | Ingest health, storage, hidden audit, search playground, PPR trigger, verify trigger |
| `/admin/brain/metrics` | Configurable metric chart grid (visx) |
| `/admin/brain/events` | Faceted event log browser |
| `/admin/brain/query-logs` | Search history + full rank explanation + LTR feedback |
| `/admin/brain/extractors` | Per-extractor health (queue, latency, failures) |
| `/admin/brain/live` | Real-time artifact stream WebSocket |
| `/admin/brain/config` | Per-org/per-project/global tunables |
| `/admin/brain/export/:session_id` | Session export tarball |

### Mobile (Expo, new tabs additive to existing NoSleep mobile)

| Tab | Purpose |
|---|---|
| **Capture** | Primary: capture thought (text / voice / photo / URL paste). Live metadata preview. Offline queue. |
| **Recent** | Thoughts + Sessions timeline, project-filtered, cached 30d offline LRU 100MB cap |
| **Nav** | Topics / People / Projects / Types / Archive chip-based navigation. No D3. List-based. |

Plus extensions: Session detail (full replay), Artifact detail (kind-aware), Image gallery fullscreen viewer. Bookmarklet + iOS share extension in Phase 9.

## MCP tools

Third MCP server per org: `nosleep-brain-<org>` (alongside existing control + memory). Nate's four tool names preserved for cross-tool compatibility.

Core (aligned with Nate):
- `capture_thought(content, project_id, source_refs?, thought_type_hint?)`
- `search_thoughts(query, project_id, limit, threshold, scope?)`
- `list_thoughts(project_id, type?, topic?, person?, days?, limit?)`
- `thought_stats(project_id, scope?)`

Our extensions:
- `get_thought(id)`, `related_thoughts(id, limit)`, `promote_artifact(archive_hash, project_id, thought_type?)`, `audit_thoughts(project_id, include_hidden?)`
- `search_archive(QuerySpec)`, `get_artifact(hash)`, `session_artifacts(session_id, since?, limit?)`
- `capture_url(url, project_id, mode, note?, tags?)`
- `brain_metrics(metric_key, project_id?, from, to, resolution)`, `brain_events(event_type?, from, to, filters)`, `brain_query_logs(from, to, filters)`

## Performance budgets

- **Ingest path (hook → skeleton row written)**: <100 ms p95.
- **Catalog-filtered project query (2–4 sealed files)**: <150 ms warm, <500 ms cold.
- **Full 21-file fan-out deep search (worker pool)**: <1 s without LLM rerank, <1.5 s with.
- **D3 graph render (default scope, <500 nodes)**: <300 ms initial layout.
- **Mobile capture POST (online)**: <250 ms round-trip.
- **Mobile offline queue flush on reconnect**: <5 s for 50 pending thoughts.

## Implementation phases

Full spec per phase in `10-phase-0-foundation.md` and outlines in `11-*` through `20-*`.

| # | Phase | Deliverable |
|---|---|---|
| 0 | Foundation | Schema + triggers + ingest endpoint + hook wiring. Silent capture. |
| 1 | Archive retrieval | FTS + facet + temporal search. Archive browser + session replay. URL `ref` mode. |
| 2 | Thoughts | thoughts table + metadata extractor + Nate's 4 MCP tools + auto-capture skill + mobile Capture/Recent. query_logs minimal. |
| 3 | Semantic search | bge-m3 embeddings + sqlite-vec + RRF hybrid + cross-encoder rerank. URL `full` mode. |
| 4 | Entities + cross-ref | entities + entity_refs + thought_refs + thought_archive_refs. Entity hub. Manual linking UI. |
| 5 | Visual + code | pHash + CLIP + OCR + scene + caption + AST. Image gallery. Code-centric nav. PDF handler. |
| 6 | D3 graph | `/brain` force-directed + worker-thread simulation + PPR-seeded layout. |
| 7 | Observability | metrics + rollups + event tables + admin dashboards + config UI. Parallel with 5/6. |
| 8 | Scale | Per-file HNSW + worker pool fan-out + smart file selection + zstd dictionaries + verify-hash. |
| 9 | Polish | Mobile Nav/Settings/voice/offline full. Timeline/compare/export/live. LLM rerank. Bookmarklet. iOS share. |
| 10 | Advanced | LLM edge proposer (gated). LTR training. Entity merge UI. OpenCode webhook. Retroactive backfill. |

**V1 cut = phases 0–4**. "Brain works" milestone.

## Locked decisions (canonical list)

1. Per-org storage, hard isolation, directory-per-org.
2. Quarterly seal, 20 sealed + 1 active per org, 5-year hot retention.
3. Single storage engine: SQLite + sqlite-vec + FTS5 + inline HNSW (Phase 8) + R-Tree + kind-specific feature tables + metric/event tables.
4. Append-only archive, project-level soft-delete, no physical delete outside legal erasure.
5. N orthogonal retrieval modalities (14 listed above).
6. Structured QuerySpec with hard filters + ranked retrievers fused via RRF, always-on cross-encoder rerank (Phase 3+), confidence-gated LLM rerank (Phase 9+).
7. Per-artifact-kind extractor fan-out at ingest, async workers feeding kind-specific metadata tables.
8. Project as first-class filter (NOT NULL), strict org boundary at schema + trigger level.
9. Versioned ingest contract (additive preferred, breaking changes → migration sidecar).
10. Compression: zstd per-blob, zstd dictionaries trained at seal.
11. Hierarchical path-based taxonomy with growth escape hatch.
12. Triggers enforce no-delete on all archive tables.
13. **Layer 1 (archive)** = full mechanical capture via hooks; never skill-dependent.
14. **Layer 2 (thoughts)** = Nate-style flat table + LLM metadata extraction (type/topics/people/action_items/dates_mentioned); no typed edges natively, co-occurrence-derived.
15. **(Revised Phase 12)** Thought promotion paths: user capture, auto-capture skill on session_end, explicit `promote_artifact`, mobile note, web UI, **and Haiku-driven auto-extractor on every captured `conversation/turn/{user,assistant}` artifact**. The original "never automatic classifier on assistant messages" rule was reversed once the user clarified that thoughts ARE the agent's reasoning (not user-typed material). The extractor uses a triage prompt that returns `keep:false` on routine acks; only thought-worthy turns become thoughts. Provenance is preserved via `source_kind='auto_from_artifact'` + `thought_archive_refs` back-link. Idempotent (per-artifact + normalised-content fingerprint). See `extractors/auto-thought.ts` and Phase 11 in the codebase.
16. Graph is derived from metadata co-occurrence (web D3); list-based nav on mobile.
17. `thought_archive_refs` + `thought_refs` + `artifact_edges` — three append-only edge tables.
18. Entity resolution layer promotes people/topics/concepts to first-class nodes.
19. URL capture first-class modality with `ref` and `full` modes; link hash = normalized URL SHA, fetch hash = body SHA.
20. Content-type-aware fetcher (HTML / PDF / image / JSON / video metadata / fallback).
21. Selective embedding allowlist (per-project override).
22. Catalog-driven file selection with fan-out fallback.
23. Timeseries: raw `metrics` + 1h + 1d rollups, canonical key namespace, sealed with quarter.
24. Event tables: ingest_events, extractor_runs, hook_fires, query_logs, session_events — append-only.
25. Web: D3 graph + ~15 routes under `/brain` and `/admin/brain`.
26. Mobile: three new tabs (Capture, Recent, Nav) + extensions. No D3 on mobile.
27. Mobile offline-first via expo-sqlite; 30d rolling cache, 100MB LRU cap.
28. MCP: `nosleep-brain-<org>` server with Nate's 4 tools + our extensions.
29. Graph density: 500 soft warn, 1200 force-switch from force-directed.
30. Mobile default tab: Dashboard + Settings override.
31. Voice capture: expo-speech default, cloud Whisper toggle.
32. Image upload: client-side 2048px downscale, no byte cap, 7d local original retention.
33. Score-breakdown: user-facing collapsed; full pipeline at `/admin/brain/query-logs`.
34. D3 archive layer: off by default.
35. Metric retention: raw 5y, 1h rollups 5y, 1d rollups indefinite.
36. LLM-suggested thought_refs: manual-only v1; proposer gated on >1000 thoughts + <5% high-similarity manual-link rate.
37. Embedding model: local `bge-m3` 1024-dim (diverges from Nate's cloud OpenAI; offline-first matches NoSleep).
38. Rerank: `bge-reranker-v2-m3` local cross-encoder always-on (Phase 3+); optional Haiku LLM rerank confidence-gated (Phase 9+).
39. Extraction model: Haiku 4.5 (reuses NoSleep's existing budget controls; not Nate's cloud gpt-4o-mini).
40. No cross-org shared storage; cross-org edges forbidden at insert level. Cross-project within an org allowed.

## References

- Nate B's Open Brain guide: <https://promptkit.natebjones.com/20260224_uq1_guide_main>
- Nate B's implementation (the fork we studied): <https://github.com/future-elle/open-brain-natebjones>
- MemPalace (architectural reference for hybrid retrieval + temporal validity): <https://github.com/MemPalace/mempalace>

## File map in this directory

- `00-overview.md` — this doc
- `01-schema.sql` — complete DDL
- `02-taxonomy.md` — artifact kind hierarchy + kind-specific metadata schemas
- `03-query-spec.md` — QuerySpec JSON shape + retrieval pipeline details
- `04-mcp-and-api.md` — MCP tool signatures + REST API contracts
- `10-phase-0-foundation.md` — full detail for Phase 0 (ready-to-implement)
- `11-phase-1-archive-retrieval.md` — outline
- `12-phase-2-thoughts.md` — outline
- `13-phase-3-semantic-search.md` — outline
- `14-phase-4-entities.md` — outline
- `15-phase-5-visual-code.md` — outline
- `16-phase-6-d3-graph.md` — outline
- `17-phase-7-observability.md` — outline
- `18-phase-8-scale.md` — outline
- `19-phase-9-polish.md` — outline
- `20-phase-10-advanced.md` — outline
