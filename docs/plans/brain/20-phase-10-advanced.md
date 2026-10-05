# Phase 10 — Advanced / Deferred

> Features gated on usage, scale, or explicit enablement. Do not block earlier phases on these.

## Deliverable

- LLM-suggested `thought_refs` proposer (gated).
- LTR training pipeline on accumulated `query_logs` engagement signal.
- Entity merge review UX with lazy resolution verification.
- OpenCode webhook ingestion.
- Retroactive backfill script (existing sessions → archive).
- Scheduled re-fetch policy tuning.
- Multi-tool ingestion (other MCP clients, Cursor, Zed, etc.).

## Depends on

All previous phases; enablement gated per feature.

## LLM-suggested thought_refs proposer

**Gate** (computed weekly job):
- Org has > 1000 thoughts
- AND < 5% of thought-pairs with cosine > 0.8 have any user-created `thought_refs`

Only when both hold: enable nightly proposer.

**Proposer logic** (`packages/server/src/brain/proposer/thought-ref-proposer.ts`):
1. Iterate thought pairs (a, b) where cosine(a.emb, b.emb) > 0.8, filtered to same project.
2. Skip pairs with existing `thought_refs`.
3. Batch 20 pairs per Haiku prompt:
   ```
   For each pair (thought_a, thought_b), return a relation from:
   {refines, supersedes, contradicts, duplicate_of, related_to, null}
   plus a one-line justification.
   null means no meaningful relation.
   ```
4. Land suggestions in `thought_ref_suggestions(id, from_id, to_id, relation, justification, created_at, reviewed)`.
5. Admin UI `/admin/brain/suggestions` queue for approval.
6. Approved → insert into `thought_refs` with `origin='llm_suggested_approved'`. Rejected → mark reviewed.

Never auto-applied.

## LTR training pipeline

**Input**: `query_logs` with populated `used_ids_json` (engagement signal).

**Pipeline**:
1. Export job: CSV per org per month with (query_features, candidate_features, label=used?).
2. Offline training: LightGBM on export. Produces a ranker model (small: < 1 MB).
3. Deployment: model loaded by retrieval pipeline as an optional third-stage rerank (before cross-encoder or after, TBD per eval).
4. A/B: queries split into control (no LTR) vs. treatment (LTR applied) with engagement delta measured.

## Entity merge review

Merges currently propose via `POST /api/brain/entities/:id/merge-into`. Phase 10:
- `/admin/brain/entities/merge-queue` page.
- Review interface shows both entities + their refs + canonical names + aliases.
- Approve → `merged_into` set lazily (no row rewrites).
- Reject → cleared.
- Audit trail in `brain_session_events` with event_type='entity_merge_decision'.

## OpenCode webhook

- `POST /api/brain/webhook/opencode` — accepts OpenCode session events in their native shape.
- Adapter translates to `IngestRequest` per hook-style mapping.
- Requires OpenCode to emit hooks similar to Claude Code's.
- Same kind taxonomy reused.

## Retroactive backfill

- Script (`packages/server/scripts/brain-backfill.ts`) iterates existing NoSleep `session_events`, `messages`, `tool_uses` tables.
- For each historic session: reconstruct artifact stream per hook-to-kind map, emit to `/api/brain/ingest`.
- Throttled (100 req/sec), progress tracked, resumable.
- Run once per org, post-deploy.

## Scheduled re-fetch

- Tunable via admin config: `url.refetch.interval_days = 7`, `url.refetch.max_age_days = 90`.
- Job iterates `reference/link` artifacts captured in full mode, re-fetches, compares body-hash, creates new `document/web_fetch` + supersede edge if changed.

## Multi-tool ingestion

Other MCP clients (Cursor, Zed, VSCode Claude extension) hitting the same `/api/brain/ingest` endpoint. Each tool registers its `source_tool` + version.

## Success criteria

- LLM proposer produces suggestions with >70% approval rate in review queue.
- LTR treatment group shows measurable engagement delta (> 5% improvement) vs. control.
- OpenCode sessions captured with same shape as Claude Code sessions.
- Historic sessions backfilled — searchable alongside live ones.

## Out of scope

Anything not listed above. Feature requests hitting this phase bar get their own plan doc under `docs/plans/brain-future/`.
