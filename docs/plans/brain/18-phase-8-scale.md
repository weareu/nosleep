# Phase 8 — Scale + Resilience

> 5-year fan-out queries under 1 s. Storage efficiency. Recovery-safe.

## Deliverable

- Per-file HNSW indexes built at seal time (inlined as BLOB in sealed SQLite file).
- Quarterly seal automation.
- zstd dictionary training at seal time.
- Worker-pool fan-out for deep search.
- Smart catalog-driven file selection for default queries.
- `better-sqlite3` compiled with `SQLITE_MAX_ATTACHED=32`.
- Warmth job (touches old sealed files weekly to keep pages in OS cache).
- Sealed file verify-hash job.
- Storage stats + compression ratio metrics.

## Depends on

Phase 3 (embeddings exist), Phase 7 (metrics/events).

## Key work items

1. Seal job (`packages/server/src/brain/seal/seal-job.ts`):
   - Triggered quarterly (cron) or on-demand.
   - Steps per seal:
     1. Stop writes to `active.db` (brief pause, <30 s).
     2. `VACUUM INTO 'sealed-YYYY-QN.db'` new file.
     3. Train zstd dictionary on quarter's text content, store in new file's `meta` table.
     4. Re-compress large blobs using dictionary (optional; first pass skip).
     5. Build HNSW indexes (vec_text, vec_clip) via usearch; serialize to BLOB; INSERT into new file's `vec_hnsw_blob`.
     6. Compute full-file SHA-256; store in `catalog.db.sealed_files.verify_hash`.
     7. Register file in `catalog.db.sealed_files` + `catalog.db.catalog_files` (project-to-file map).
     8. Truncate / rotate `active.db` — start new quarter.
2. HNSW integration (`packages/server/src/brain/vec/hnsw.ts`):
   - Use `usearch-node` (or equivalent) — single-file index, mmap-able, fast.
   - At seal: gather all vectors from `vec_text` / `vec_clip`, build HNSW (M=16, efConstruction=200), serialize, store as BLOB.
   - At query: catalog identifies candidate files; for each, load HNSW blob (mmap from BLOB via `sqlite3_blob_open`), query with efSearch=64, return top-K.
3. Worker-pool fan-out (`packages/server/src/brain/retrieval/fan-out.ts`):
   - N workers = min(CPU cores, num_sealed_files).
   - Each worker opens its own `better-sqlite3` connection to one sealed file + HNSW blob.
   - Dispatch query to all workers in parallel, collect top-K per file, RRF merge in main thread.
   - Warm worker reuse across queries.
4. Smart file selection (`packages/server/src/brain/catalog/select-files.ts`):
   - Input: QuerySpec filters (project_id, temporal range).
   - Output: list of files to query.
   - Logic: intersect `catalog_files` (project-to-file) with `sealed_files` (date range overlap).
   - Most queries: 2-4 files → single-connection ATTACH path.
   - Deep search or >10 files → worker-pool path.
5. Build `better-sqlite3` with raised attach limit — add to `packages/server/package.json` postinstall or as custom build step.
6. Warmth job (`packages/server/src/brain/ops/warmth.ts`): weekly cron reads header + first N pages of each sealed file. Keeps OS cache warm.
7. Verify-hash job (`ops/verify.ts`): weekly cron re-hashes each sealed file, compares to `sealed_files.verify_hash`. Alert on mismatch (bit rot).
8. Metric key expansions: `seal.duration_sec`, `storage.sealed_bytes`, `storage.compression_ratio`, `hnsw.build_duration_sec`, `hnsw.size_bytes`, `warmth.last_touched_at`, `verify.last_success_at`.

## Files new

```
packages/server/src/brain/
  seal/seal-job.ts
  seal/zstd-dict-train.ts
  vec/hnsw.ts
  vec/hnsw-worker.ts
  retrieval/fan-out.ts
  catalog/select-files.ts
  ops/warmth.ts
  ops/verify.ts
```

## Deps added

- `usearch-node` (or `hnswlib-node` as alternative)
- `zstd-napi` (if not already added Phase 0 for compression)
- Custom `better-sqlite3` build config for `SQLITE_MAX_ATTACHED=32`

## Success criteria

- Seal a quarter → new file created, active.db rotated, queries still work across both.
- HNSW query on 300K-vector sealed file: <5 ms.
- 5-year deep search (21 files fan-out): <1 s cold, <300 ms warm.
- Dictionary-trained compression: 5–10× over plain zstd on conversational content.
- Bit-rot detection: modify a sealed file byte externally, verify job alerts within a week.

## Out of scope

- Cross-region replication (future, not in-plan)
- Cold tier beyond 5y (future)
