# Phase 9 — Polish + Mobile Depth

> Full UX coverage. Mobile parity. LLM rerank tier. Export. Advanced capture surfaces.

## Deliverable

- Mobile Nav tab live (Topics / People / Projects / Types / Archive).
- Mobile Settings preferences (default tab, voice provider, image cache tier).
- Voice capture (expo-speech local + cloud Whisper toggle).
- Full offline sync (conflict-free, LRU eviction 100MB cap, 30d rolling cache).
- Web: `/brain/timeline`, `/brain/compare`, `/brain/commands`, `/brain/references`, admin live-stream.
- Session/project/thought-with-refs export endpoints.
- LLM rerank tier (Haiku, confidence-gated).
- Score-breakdown tooltips finalized (user-facing collapsed + full at `/admin/brain/query-logs/:id`).
- Bookmarklet for web (one-click URL capture).
- iOS share extension for mobile (share URL/text to NoSleep brain).

## Depends on

Phases 3, 5, 7.

## Key work items

1. Mobile Nav tab (`packages/mobile/src/screens/brain/NavScreen.tsx`): four segments (Topics chip cloud, People list, Projects cards, Types chips) + Archive browse mode.
2. Mobile Settings additions (`packages/mobile/src/screens/SettingsScreen.tsx` extension):
   - `brain.default_tab`: Dashboard | Capture | Recent | Nav
   - `brain.voice_provider`: expo-speech | whisper
   - `brain.image_cache`: metadata-only | thumbnails | full
   - `brain.offline_cache_mb`: default 100
3. Voice capture integration — expo-speech as primary, Whisper via OpenRouter as Settings-gated alternative.
4. Offline sync polish (`packages/mobile/src/services/brain-sync.ts`):
   - Conflict-free via local-id + server-assigned-ULID on submit
   - LRU eviction with configurable cap
   - Selective sync (metadata vs. full content vs. with-images)
   - Background fetch on iOS (`expo-background-fetch`)
5. Web advanced pages:
   - `/brain/timeline` — chronological feed over archive
   - `/brain/compare` — two-artifact side-by-side with kind-aware diff rendering
   - `/brain/commands` — command log viewer (filter by exit_code, duration, cwd, text)
   - `/brain/references` — reference/link list, grouped by domain, og-image thumbnails
6. Export endpoints:
   - `GET /api/brain/export/session/:id` — tarball stream (manifest.json + blobs/)
   - `GET /api/brain/export/project/:id` — project-wide tarball (potentially large — streamed)
   - `GET /api/brain/export/thought/:id` — thought + referenced archive bundle
7. LLM rerank (`packages/server/src/brain/rerank/llm-rerank.ts`):
   - Haiku 4.5, batched prompt
   - Gate: top-5 fused+cross-encoder confidence < τ_llm (default 0.35) OR explicit `rerank.llm='on'`
   - Returns ranked ids with justifications — persisted in `query_logs.reranked_top_json`
8. Score-breakdown UI polish — inline collapsed chips with smooth expansion animation, full breakdown at admin query-log detail.
9. Bookmarklet:
   - `javascript:void(fetch('https://nosleep.../api/brain/capture-url', {method:'POST', headers:{'x-api-key':...}, body:JSON.stringify({url:location.href, project_id:'...', mode:'full'})}))`
   - Config UI to generate per-user bookmarklet with baked-in project default.
10. iOS share extension — Expo managed with `@react-native-share/extension` or equivalent; accept URL or text, forward to NoSleep API.
11. Scheduled re-fetch for references (optional background job): stale URLs re-fetch weekly; content-hash change → new web_fetch + supersede edge.

## Files new

```
packages/server/src/brain/
  rerank/llm-rerank.ts
  export/session-export.ts
  export/project-export.ts
  export/thought-export.ts
  routes/export.ts
  extractors/url-refetch.ts
packages/web/src/pages/brain/
  Timeline.tsx
  Compare.tsx
  Commands.tsx
  References.tsx
  Bookmarklet.tsx              # settings page to generate bookmarklet
packages/mobile/src/screens/brain/
  NavScreen.tsx
  (extend SettingsScreen)
packages/mobile/ios/share-extension/
  (native share extension bundle)
```

## Deps added

- `expo-background-fetch`
- `@visx/sankey` (for compare view flow diffs — optional)
- `react-photo-album` (if not added in Phase 5 for gallery)

## Success criteria

- Mobile: switch voice provider in Settings, voice capture uses selected provider.
- Offline: capture 10 thoughts offline, reconnect, all sync correctly with no duplicates.
- Share a URL from Safari via iOS share sheet → lands in brain with correct project attribution.
- Bookmarklet capture works for any web page.
- Compare view: pick two file_snapshots of same path → rendered as diff.
- LLM rerank only fires when fused confidence < 0.35.

## Phase 6 deferrals landing here

Phase 6 (D3 graph) shipped force-directed as the flagship layout. The
following pieces were spec'd in 16-phase-6-d3-graph.md but consciously
deferred to this Phase-9 polish iteration so they didn't block V1:

1. **Timeline layout toggle** — x-axis = `created_at`, y-lane per
   `thought_type`, edges as arcs. Replaces force-directed when nodes are
   ordered by recency (e.g. session timelines, recent decisions).
2. **Grid-by-topic layout toggle** — columns = top-N topic entities, rows
   chronological within each topic; useful for "what we've thought about
   X recently" reads.
3. **LOD rendering at zoom < 0.4** — at low zoom show entity nodes only +
   thought nodes with degree > 2; everything else fades to opacity 0. Keeps
   the canvas legible when scrolling out for global structure.
4. **Worker-thread force simulation** — current main-thread `d3-force` runs
   well under the 500-node soft limit. Migrate to a `workerize-loader`
   simulation worker once orgs regularly cross 800 nodes so dragging
   stays smooth.
5. **Pre-computed PPR seed positions** — personalised PageRank over
   `thought_cooccur` + `thought_refs` + `entity_refs` nightly; seeds the
   force-layout initial positions so renders converge instantly. Drops
   in via `/api/brain/graph?with_ppr=true`.
6. **Score-breakdown tooltips** — expand the search-result hover card to
   show per-retriever rank contributions inline (BM25 #3, semantic #1,
   RRF #1, rerank #1) so users can debug why a result placed where it did.

All six are independent of each other — pick the highest-value first when
this iteration starts.

## Out of scope

- LTR training (Phase 10)
- Entity merge review UI (Phase 10 — may move here)
- LLM-suggested thought_refs (Phase 10, gated)
