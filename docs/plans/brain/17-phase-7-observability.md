# Phase 7 — Observability + Admin

> Tune retrieval. Watch ingest health. Debug queries. Can run parallel with Phases 5 and 6.

## Deliverable

- Metrics + rollups populated from ingest, budget, supervision, system-stats, extractor runs.
- Event tables fully written (already schema'd; now every ingest emits `ingest_events`, every extractor emits `extractor_runs`, every hook fire emits `hook_fires`, supervision emits `brain_session_events`).
- Rollup job nightly (1h) + weekly (1d).
- Web: `/admin/brain`, `/admin/brain/metrics`, `/admin/brain/events`, `/admin/brain/query-logs`, `/admin/brain/extractors`, `/admin/brain/config`.
- Per-project metric dashboard `/brain/project/:id/metrics`.
- WebSocket live stream `/admin/brain/live`.
- MCP: `brain_metrics`, `brain_events`, `brain_query_logs`.
- Unified with existing NoSleep `system-stats` (writes into same `metrics` table).

## Depends on

Phase 0 (event tables exist) + whatever has landed by now for data to observe.

## Key work items

1. Metric emission helpers (`packages/server/src/brain/metrics/emit.ts`): thin API `emit(metric_key, value, tags?, project_id, org_id)` writes raw point into `metrics`. Callers:
   - Ingest pipeline (tokens, artifacts.ingested, dedup_hit_rate)
   - Extractor workers (queue_depth, latency, failure_rate)
   - Hook callback route (hook.fires, hook.latency)
   - Supervision loop (drift.detections, compaction.events, goal_reinjections, auto_advance)
   - Validation (success_rate, retry_rate)
   - Budget pacer (budget.pacing_state transitions, tokens.*, cost.*)
   - Existing `system-stats` route — switch from its current store to this.
2. Rollup job (`packages/server/src/brain/metrics/rollup-job.ts`): nightly aggregation into `metrics_rollup_1h` (last 25 h) and `metrics_rollup_1d` (last 8 d). Re-running is idempotent (UPSERT by PK).
3. Query log write-through: every `/api/brain/search` call writes a `query_logs` row with per-retriever candidates + fused + reranked.
4. LTR feedback: `PATCH /api/brain/query-logs/:id { used_ids: [...] }` for agent/user to record what they actually used. Collect silently.
5. Web admin pages — visx-based charts (`packages/web/src/pages/admin/brain/`):
   - `MetricsDashboard.tsx` — grid of panels, user-configurable (drag-resize-add-remove). Default panels from canonical key list.
   - `EventsBrowser.tsx` — faceted filter + infinite-scroll rows across 4 event tables (sans query_logs).
   - `QueryLogs.tsx` — list + `/:id` detail view with full pipeline rendering + "correct/wrong" LTR buttons.
   - `ExtractorHealth.tsx` — tile per extractor (gauge + latency chart + recent runs).
   - `BrainAdminDashboard.tsx` — top-level tiles: ingest health, storage, hidden-project audit, PPR last-run, search-playground link.
   - `BrainConfig.tsx` — per-org / per-project / global settings forms writing `catalog.db.brain_config`.
   - `LiveStream.tsx` — WebSocket client.
6. Chart lib: `@visx/visx` (or compose `@visx/axis`, `@visx/scale`, `@visx/shape` directly).
7. Mobile sparklines (`packages/mobile/src/components/Sparkline.tsx`) for Dashboard/Recent/Project cards.
8. Admin routes on server side.

## Files new

```
packages/server/src/brain/
  metrics/
    emit.ts
    rollup-job.ts
    canonical-keys.ts        # enforces namespace
  routes/
    admin-health.ts
    admin-storage.ts
    admin-metrics.ts
    admin-events.ts
    admin-query-logs.ts
    admin-extractors.ts
    admin-config.ts
    admin-live-ws.ts
packages/mcp-brain/src/tools/
  brain-metrics.ts
  brain-events.ts
  brain-query-logs.ts
packages/web/src/pages/admin/brain/
  BrainAdminDashboard.tsx
  MetricsDashboard.tsx
  EventsBrowser.tsx
  QueryLogs.tsx
  ExtractorHealth.tsx
  BrainConfig.tsx
  LiveStream.tsx
  components/
    Panel.tsx
    TimeRangePicker.tsx
    MetricChart.tsx          # visx line/area/bar/histogram/heatmap wrappers
    IntentWeightsMatrix.tsx
    EmbedAllowlistEditor.tsx
packages/mobile/src/components/
  Sparkline.tsx
```

## Deps added

- `@visx/*` set
- `ws` (already in server for existing WebSocket)

## Success criteria

- Every ingest emits `artifacts.ingested.count`, tagged by kind. Visible in `/admin/brain/metrics`.
- Nightly rollup job runs; 1h and 1d rollups visible in dashboard queries.
- Click a query log → see per-retriever candidate list, RRF fusion, rerank, final result, latency breakdown.
- Extractor queue depth visible in real-time; crossing threshold triggers alert (reuses existing NoSleep alert system).
- "Correct/wrong" LTR buttons persist feedback for Phase 10 training.

## Out of scope

- LTR training itself (Phase 10)
- Deep scale perf (Phase 8)
- Mobile analytics dashboard (stays sparklines only)
