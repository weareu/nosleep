# Phase 2 — Thoughts Layer

> Capture and browse curated notes. Auto-capture at session end. Mobile starts being useful.

## Deliverable

- `thoughts` + `thoughts_fts` tables live.
- Metadata extractor worker (own prompt) + extended type enum.
- MCP tools: `capture_thought`, `search_thoughts`, `list_thoughts`, `thought_stats`, plus `promote_artifact`, `get_thought`, `audit_thoughts`.
- Auto-capture skill installed by default in every new session.
- Web: `/brain/thoughts`, `/brain/thought/:id`.
- Mobile: Capture tab (text-only), Recent tab.
- Search-before-capture dedup warning.
- Query logs written for every thought search (more complete than Phase 1's minimal).

## Depends on

Phase 0 complete, Phase 1 complete.

## Key work items

1. Extractor worker (`packages/server/src/brain/extractors/metadata-llm.ts`) — Haiku 4.5 via existing NoSleep AI gateway; own prompt + extended types. Writes to `thoughts.metadata_json`, `thoughts.thought_type` (denormalized), also populates `artifact_num_meta` for thoughts' action_item count, dates_mentioned count.
2. `thoughts` write path (`packages/server/src/brain/thoughts/capture.ts`): insert → enqueue metadata extraction → enqueue embedding stub (Phase 3 fills).
3. Dedup pre-check — Phase 3 dependency (needs vectors). Phase 2 stub: textual similarity via FTS only; Phase 3 upgrades to semantic.
4. MCP tools in `packages/mcp-brain/` — thoughts tools activated. Signatures per `04-mcp-and-api.md`.
5. Auto-capture skill package (`packages/auto-capture-skill/` or inline in mcp-brain): ships a `SKILL.md` + registration so new sessions auto-load. Supervision loop hooks `session_end` event → invokes skill.
6. `promote_artifact` tool path: reads archive artifact content, creates thought with `source_kind='promoted_from_archive'` + `thought_archive_refs(relation='distilled_from')`.
7. Web:
   - `/brain/thoughts` — virtualized list, filter by project/type/topic/person/days.
   - `/brain/thought/:id` — content, metadata chips, source refs, incoming/outgoing thought_refs (empty in Phase 2 until Phase 4 adds them), action bar stubs.
8. Mobile:
   - **Capture tab** — text input, project pill (remembers last), preview metadata (poll server), submit button. Offline queue (expo-sqlite `local_thoughts_pending`). Sync-on-reconnect logic.
   - **Recent tab** — thoughts list + sessions list segmented control, infinite scroll, relative dates.
9. Query logs: populate `intent`, `retrievers_json`, `fused_top_json`, `reranked_top_json` (rerank stub until Phase 3), `chosen_ids_json`, `latency_ms`.

## Files new

```
packages/server/src/brain/
  extractors/metadata-llm.ts
  thoughts/capture.ts
  thoughts/promote.ts
  thoughts/search.ts
  routes/thoughts.ts
packages/mcp-brain/src/tools/
  capture-thought.ts
  search-thoughts.ts
  list-thoughts.ts
  thought-stats.ts
  promote-artifact.ts
  get-thought.ts
  audit-thoughts.ts
packages/auto-capture-skill/
  SKILL.md
  metadata.json
  README.md
packages/web/src/pages/brain/
  Thoughts.tsx
  ThoughtDetail.tsx
packages/mobile/src/screens/brain/
  CaptureScreen.tsx
  RecentScreen.tsx
  ThoughtDetailScreen.tsx
  SessionDetailScreen.tsx   # minimal; fleshed in Phase 5
packages/mobile/src/services/
  brain-api.ts
  brain-sync.ts              # offline queue reconciler
  brain-local-db.ts          # expo-sqlite mirror
```

## Metadata extraction prompt

See `PROMPT_TEMPLATE` in `packages/server/src/brain/extractors/metadata-llm.ts`
(NoSleep's own wording; output keys: type, topics, people, action_items,
dates_mentioned).

## Success criteria

- Capture a thought via MCP `capture_thought` → see it in `/brain/thoughts` within 3s (metadata may still be extracting).
- Session `Stop` hook → auto-capture skill produces 1 session-summary thought + 1 thought per ACT-NOW item identified.
- Mobile Capture tab: type a note offline, come back online, note appears in Recent tab.
- `thought_stats` returns counts + top topics + top people.

## Out of scope

- Semantic search / dedup (Phase 3)
- Entities (Phase 4)
- Thought refs UI (Phase 4)
- Graph view (Phase 6)
