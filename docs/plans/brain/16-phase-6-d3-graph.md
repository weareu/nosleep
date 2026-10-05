# Phase 6 — D3 Graph View

> Visual navigation flagship. Force-directed graph of thoughts + entities with co-occurrence edges. Web only; mobile stays list-based.

## Deliverable

- Web `/brain` route — D3 force-directed graph.
- Worker-thread force simulation.
- Pre-computed PPR seed positions for initial layout.
- Co-occurrence edge cache (`thought_cooccur` materialized view).
- Node/edge filter panel.
- Layout toggles: force / timeline / grid-by-topic.
- Archive layer toggle (default off).
- Density auto-switch at 500 / 1200 node thresholds.
- Score-breakdown tooltips in search results (user-facing collapsed).

## Depends on

Phases 2, 3, 4.

## Key work items

1. Co-occurrence job (`packages/server/src/brain/graph/cooccur-job.ts`): nightly batch computing `thought_cooccur` rows:
   - shared_topic (Jaccard on topics arrays)
   - shared_people (Jaccard on people arrays)
   - same_session
   - temporal_near (within 30 min)
   - source_linked (shared archive source_refs)
   Threshold weight ≥ 0.15 to avoid hairball.
2. PPR pre-compute (`graph/ppr-job.ts`): personalized pagerank over `thought_cooccur` + `thought_refs` + `entity_refs`; per-seed top-100; nightly. Store in `ppr_scores`.
3. `GET /api/brain/graph` endpoint returns nodes + edges + PPR hints shaped per `04-mcp-and-api.md`.
4. Web D3 canvas (`packages/web/src/pages/brain/Graph.tsx`):
   - `d3-force` with custom constraints
   - Force simulation in `web-worker` (Workerize or raw worker script)
   - `d3-zoom` + `d3-drag`
   - Node shapes via SVG path generators
   - Archive toggle, layout toggle, filter panel (reuses `/brain/search` components)
5. Layout modes:
   - `force` — d3-force with topic-cluster attraction
   - `timeline` — x-axis = created_at, y-axis lane per thought_type, edges as arcs
   - `grid-by-topic` — columns = top-N topics, rows chronological within topic
6. Interactions:
   - Click node → right drawer with full thought + refs
   - Double-click → focus (center + 2-hop highlight)
   - Right-click → context menu (promote, capture related, link to, hide project)
   - Keyboard: `/`, `f`, `t`, `esc`, `+/-`, arrows, `h`
7. Performance:
   - Default scope: current project × 90d × active → typically <500 nodes
   - >500: soft banner "Large graph — consider timeline layout"
   - >1200: force-switch to timeline (disable force-directed with explanation)
   - LOD at zoom<0.4: entity nodes only + thoughts with degree > 2
8. Score-breakdown tooltips (`packages/web/src/pages/brain/components/ScoreChip.tsx`): hover to expand per-retriever ranks + RRF + rerank. Admin view at `/admin/brain/query-logs/:id` gets full pipeline rendering.

## Files new

```
packages/server/src/brain/
  graph/
    cooccur-job.ts
    ppr-job.ts
    api.ts                    # node/edge shaping for D3 response
  routes/graph.ts
packages/web/src/pages/brain/
  Graph.tsx
  workers/force-sim.worker.ts
  components/
    NodeRenderer.tsx
    EdgeRenderer.tsx
    GraphFilterPanel.tsx
    LayoutToggle.tsx
    ScoreChip.tsx
    NodeDetailDrawer.tsx
```

## Deps added

- `d3` (d3-force, d3-zoom, d3-drag, d3-selection)
- `d3-scale-chromatic` (color palettes)
- `workerize-loader` or raw Worker setup

## Success criteria

- Load `/brain` with current project, 200+ thoughts + 50+ entities → force-directed graph renders in <1 s.
- Drag a node, simulation continues smoothly at 60 fps.
- Click thought → drawer shows full content + refs.
- Toggle "show archive" → small archive nodes appear dimmed.
- Scale test: 1200 thoughts project → banner shows, force-directed still usable; 1500 → timeline enforced.

## Out of scope

- Mobile graph (never shipping — wrong form factor)
- LLM-suggested edges (Phase 10)
- Admin query-log UI (Phase 7)
