# Phase 3 — Semantic Search + Cross-Encoder Rerank

> "Find what means this." Multi-modal baseline.

## Deliverable

- `bge-m3` embeddings (local), async worker.
- `sqlite-vec` loaded; `vec_text` virtual table created + populated.
- Hybrid retrieval: FTS + vector, combined via RRF (k=60).
- `bge-reranker-v2-m3` cross-encoder rerank always-on, top-100 → top-20.
- URL `full` mode: Readability → markdown, metadata extraction, embedding.
- Embed allowlist config live (per-org default, per-project override).
- Search-before-capture dedup upgraded to semantic.

## Depends on

Phase 2.

## Key work items

1. Load `sqlite-vec` via existing pattern in `db/schema.ts`. New brain-specific module loads into brain DBs.
2. Embedding worker (`packages/server/src/brain/extractors/embedding-text.ts`): bge-m3 local via `@xenova/transformers` or server-side `llama.cpp` binding. Model file shipped via `npm postinstall` pull or lazy-download on first run. 1024-dim. Queue-driven, consumes `vec_text_map` rows where `embedded_at IS NULL`.
3. Chunking strategy: 256-token windows, stride 128, preserve context. Chunked content stored in `vec_text_map.chunk_text`. Large artifacts produce many rows.
4. Vector retriever (`packages/server/src/brain/retrieval/retrievers/semantic-text.ts`): query embed → `vec0` MATCH + distance → join `vec_text_map` → hash back to artifacts or thoughts.
5. RRF fusion (`packages/server/src/brain/retrieval/rrf.ts`): accepts ranked lists from N retrievers with weights, returns fused top.
6. Cross-encoder worker (`packages/server/src/brain/rerank/cross-encoder.ts`): bge-reranker-v2-m3, kept warm in a worker thread (onnxruntime-node or transformers.js). Batched input, returns scores [0,1].
7. Embed allowlist enforced in extractor queue logic: only enqueue embedding for allowlisted kinds.
8. Per-project override in `catalog.db.brain_config` keyed by `embed_allowlist.<project_id>`.
9. URL `full` mode (`packages/server/src/brain/extractors/url-full.ts`): Readability.js (via `@mozilla/readability` through jsdom or equivalent) → markdown, og/meta/published_at extract, inline-image fetch, link artifact + `document/web_fetch` artifact + edge.
10. Search-before-capture dedup upgraded: semantic cosine > 0.85 → return `similar_existing`.
11. QuerySpec response adds `score_breakdown` for admin/debug mode.
12. Web: `/brain/search` shows score chips, hover expands per-retriever breakdown.

## Files new

```
packages/server/src/brain/
  extractors/embedding-text.ts
  extractors/url-full.ts
  retrieval/retrievers/semantic-text.ts
  retrieval/rrf.ts
  rerank/cross-encoder.ts
  rerank/reranker-worker.ts           # worker_threads for onnx model
  models/                              # local model dir, gitignored; lazy-download logic
  config/embed-allowlist.ts
```

## Deps added

- `@xenova/transformers` OR `onnxruntime-node` (pick based on perf benchmarks)
- `@mozilla/readability` + `jsdom`
- `sqlite-vec` (already in server per existing vector pattern — confirm in package.json)

## Success criteria

- Query "how did we handle token refresh" → returns both archive turns AND thoughts about it, ranked by semantic + lexical fusion.
- Cross-encoder rerank cuts through "looks similar but irrelevant" false positives visible in Phase 1 results.
- URL `full` capture: fetch a blog post → full markdown stored, inline images archived, embedding populated, searchable by content within 30 s.
- `fail_if_similar_over: 0.95` on capture_thought prevents exact near-duplicates.

## Out of scope

- Image CLIP/pHash (Phase 5)
- Entities (Phase 4)
- HNSW indexes (Phase 8)
- LLM rerank (Phase 9)
