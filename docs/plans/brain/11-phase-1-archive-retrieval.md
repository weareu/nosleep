# Phase 1 — Archive Retrieval

> Make the archive queryable. Keyword search + facet + temporal filters. No semantic yet. Plus URL `ref` mode.

## Deliverable

- `POST /api/brain/search` with text + facet + temporal; text = lexical (FTS5) only.
- Web: `/brain/archive` flat browser (virtualized), `/brain/session/:id` replay (basic kind renderers), `/brain/search` form.
- URL capture `mode='ref'`: fetch og tags, create `reference/link`. No full extraction.
- MCP: `search_archive(QuerySpec)`, `get_artifact(hash)`, `session_artifacts(session_id, ...)`.
- Basic `query_logs` (minimal fields) written per search.

## Depends on

Phase 0 complete.

## Key work items

1. Wire FTS5 population in ingest pipeline. Phase 0 already writes to `artifacts_fts_src`; add trigger copies into `artifacts_fts` (declared in schema) so every ingested text artifact is immediately keyword-searchable.
2. Hard filter builder (`packages/server/src/brain/retrieval/filters.ts`): takes facets + numeric + temporal + scope → parameterised SQL WHERE.
3. BM25 retriever (`packages/server/src/brain/retrieval/retrievers/bm25.ts`): FTS5 MATCH + bm25() scoring.
4. Temporal retriever stub (point + interval filter only; ranking via exp-decay lands with intent weights).
5. QuerySpec validator (`packages/server/src/brain/retrieval/query-spec.ts`): Zod schema per `03-query-spec.md`, reject invalid shapes.
6. Result shaper (`packages/server/src/brain/retrieval/response.ts`): kind-aware snippet extraction.
7. `/api/brain/search` Fastify route, auth'd.
8. `/api/brain/artifacts/:hash` read route with `include` query params.
9. `/api/brain/sessions/:session_id/artifacts` paginated read.
10. URL fetcher worker (`packages/server/src/brain/extractors/url-fetcher.ts`): fetch + og-tag parse (using `cheerio`), insert `reference/link` artifact. Mode=ref only; skip Readability.
11. MCP brain server scaffold (`packages/mcp-brain/`): new package mirroring mcp-control / mcp-memory structure. Exposes `search_archive`, `get_artifact`, `session_artifacts`. Wired into `.mcp.json` for all 3 orgs.
12. Web dashboard:
    - Route `/brain/archive` — virtualized table/list, filter panel (project, kind prefix tree, date), snippet column with FTS highlights.
    - Route `/brain/search` — structured QuerySpec builder form.
    - Route `/brain/session/:id` — virtualized transcript, kind renderers for conversation/turn/*, code/diff, code/file_snapshot, process/command_output (others deferred to Phase 5).
    - Route `/brain/artifact/:hash` — generic detail with content + edges + ingest_event.
13. Minimal query_logs record per search (query_spec_json, latency_ms; no per-retriever breakdown until Phase 3).

## Files new

```
packages/server/src/brain/
  retrieval/
    query-spec.ts
    filters.ts
    response.ts
    retrievers/bm25.ts
    retrievers/temporal.ts
    rrf.ts                    # shell — only lexical feeds it in Phase 1
  extractors/url-fetcher.ts
  routes/search.ts
  routes/artifacts.ts
  routes/sessions.ts
  routes/capture-url.ts
packages/mcp-brain/
  src/index.ts                # Nate-shape tools — thoughts ones stubbed, archive ones live
  src/tools/search-archive.ts
  src/tools/get-artifact.ts
  src/tools/session-artifacts.ts
  src/tools/capture-url.ts
  package.json
  tsconfig.json
packages/web/src/pages/brain/
  Archive.tsx
  Search.tsx
  SessionReplay.tsx
  ArtifactDetail.tsx
  components/
    FilterPanel.tsx
    KindPrefixTree.tsx
    KindRenderer.tsx
    SnippetWithHighlights.tsx
```

## Performance

- Warm-cache BM25 over 500K-row `active.db`: <50 ms typical.
- Cold first-page: <200 ms.
- Session replay loads 1000 artifacts in <400 ms via pagination.

## Success criteria

- From a captured session, search "jwt" → returns assistant messages and diffs mentioning jwt, ranked by BM25.
- `/brain/session/:id` shows full transcript chronologically with kind renderers.
- MCP `search_archive` callable from a Claude Code session, returns matches.
- URL ref capture via `POST /api/brain/capture-url mode=ref` produces `reference/link` artifact in <1 s.

## Out of scope for Phase 1

- Semantic (Phase 3)
- Thoughts (Phase 2)
- Image/code renderers (Phase 5)
- Admin UI (Phase 7)
- D3 graph (Phase 6)
