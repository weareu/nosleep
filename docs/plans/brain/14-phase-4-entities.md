# Phase 4 — Entities & Cross-Ref

> Browse by person/topic/concept. Manual thought linking. Cross-project discovery without weakening org boundary.

## Deliverable

- `entities` + `entity_refs` tables populated by entity-resolver worker.
- `thought_refs` table live; manual linking UI.
- `thought_archive_refs` active (bridge between layers).
- Lazy merge via `entities.merged_into`.
- Web: `/brain/entity/:id` hub page.
- Cross-project entity queries.
- MCP: `related_thoughts(id, limit, modalities?)`.
- Add entity filter to QuerySpec.

## Depends on

Phases 2, 3.

## Key work items

1. Entity resolver worker (`packages/server/src/brain/extractors/entity-resolver.ts`): after metadata_llm completes, iterate `people[]` and `topics[]`, resolve against `entities` by canonical_name OR alias, create-if-missing, insert `entity_refs`.
2. Pronoun/generic filter (`extractors/entity-filter-list.ts`): rule-based skip list for "he", "they", "the user", "this", "that", etc.
3. Lazy merge resolution in query layer: `WITH RECURSIVE resolved AS (SELECT id, COALESCE(merged_into, id) AS canonical_id ...)` — follow the chain; cap depth at 5 to prevent cycles.
4. Cross-project entity query endpoint: `GET /api/brain/entities/:id?include=refs,related` returns refs across ALL active projects in the entity's org.
5. Related-thoughts computation:
   - `edges` modality: traverse `thought_refs`
   - `entities` modality: entity co-occurrence (shared entity_refs)
   - `session` modality: same-session thoughts
   - `topics` modality: shared metadata_json topics array
6. Web:
   - `/brain/entity/:id` — header (canonical + aliases editable), stats, tabs (Mentions / Related entities / Aliases / History), 1-hop mini-graph (reuse D3 at small size — Phase 6 full graph deps not required for mini).
   - Entity merge queue page at `/admin/brain` (approve/reject pending merges).
7. Manual edge creation UI: in `/brain/thought/:id` action bar, "Link to…" → modal with search, picks target thought + relation (refines/supersedes/contradicts/related_to/etc.), POST to `/api/brain/thought-refs`.
8. QuerySpec `entities` filter wired — hard filter via `entity_refs` intersection.

## Files new

```
packages/server/src/brain/
  extractors/entity-resolver.ts
  extractors/entity-filter-list.ts
  entities/merge-resolver.ts
  entities/related.ts
  routes/entities.ts
  routes/thought-refs.ts
packages/mcp-brain/src/tools/
  related-thoughts.ts
packages/web/src/pages/brain/
  EntityHub.tsx
  components/
    MiniGraph.tsx              # minimal D3 force for 1-hop
    LinkThoughtModal.tsx
    AliasEditor.tsx
```

## Success criteria

- Capture thought mentioning "Jane" twice → one entity `ent_...` kind=person, two `entity_refs`.
- `GET /brain/entity/:id` for Jane shows both thoughts across whatever projects they're in (within org).
- Merge two topic entities "auth-mw" and "auth-middleware" → queries for either resolve to merged entity's refs.
- `related_thoughts(id)` returns thoughts via each modality with score breakdown.
- Manual `thought_refs` edge creation persists and shows in both directions (incoming/outgoing).

## Out of scope

- LLM-suggested edges (Phase 10, gated)
- Full graph UI (Phase 6)
- Bulk alias import (Phase 9 polish)
