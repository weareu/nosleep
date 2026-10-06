# NoSleep Brain — QuerySpec & Retrieval Pipeline

> The brain accepts **structured queries**, not raw strings. This doc pins the JSON shape and the retrieval pipeline.

## QuerySpec JSON

```json
{
  "org_id": "org_work",
  "project_id": "proj_auth_rewrite",
  "scope": "project",
  "layers": ["archive", "thoughts"],
  "include_hidden": false,

  "text": {
    "query": "jwt migration",
    "mode": "hybrid",
    "weight": 1.0
  },
  "image": {
    "phash": 12345678901234567,
    "vector_ref": "artifact_hash_xyz",
    "weight": 1.0
  },
  "temporal": {
    "from": 1735689600,
    "to": 1743465600,
    "near_artifact": "abc123...",
    "window_sec": 1800,
    "weight": 0.5
  },
  "graph": {
    "seed_hash": "abc123...",
    "depth": 2,
    "edge_types": ["produced_by", "turn_wrote_diff"],
    "weight": 0.5
  },
  "facets": {
    "kind_prefix": ["conversation/turn/assistant_message", "decision/"],
    "origin": "claude-code",
    "session_id": "sess_9f12",
    "actor": "agent_sonnet"
  },
  "entities": ["ent_01HXXX", "ent_01HYYY"],
  "numeric": {
    "exit_code": {"ne": 0},
    "size": {"gt": 1048576},
    "duration_ms": {"between": [1000, 30000]}
  },

  "intent": "find_decisions",
  "limit": 20,
  "rerank": {
    "cross_encoder": true,
    "llm": "confidence_gated"
  },
  "return_score_breakdown": true
}
```

### Field semantics

| Field | Type | Semantics |
|---|---|---|
| `org_id` | required | Set by API auth; clients never override. |
| `project_id` | required | `_org_level` sentinel allowed. |
| `scope` | `'project'\|'org'` | Default `'project'`. `'org'` fans across all projects in org. |
| `layers` | `string[]` | `'archive'\|'thoughts'`. Default both. |
| `include_hidden` | bool | Default false. True opens hidden projects (audit). |
| `text.mode` | `'lexical'\|'semantic'\|'hybrid'` | Default hybrid. |
| `text.weight` | float | Retriever priority in RRF fusion. Default 1.0. |
| `temporal.window_sec` | int | Only meaningful with `near_artifact`. |
| `graph.depth` | 1\|2\|3 | >3 rejected (too expensive). |
| `facets` | object | **Hard filter**, applied as SQL WHERE. Zero scoring cost. |
| `entities` | `string[]` | Hard filter; artifact/thought must appear in `entity_refs` for all listed. |
| `numeric` | object | Hard filter via `artifact_num_meta`. Operators: `gt`, `lt`, `eq`, `ne`, `between`. |
| `intent` | string | If omitted, classifier infers. Drives per-retriever weights + per-layer priors + kind-prefix boosts. |
| `rerank.llm` | `'on'\|'off'\|'confidence_gated'` | Default gated. Only fires if top RRF confidence < `τ_llm` (default 0.35). |
| `return_score_breakdown` | bool | Admin/debug mode; result rows include per-retriever ranks + RRF + rerank scores. |

## Intent taxonomy

Intent sets retriever weights and layer priors. Locked list:

| Intent | Thoughts prior | Archive prior | Dominant retrievers | Kind-prefix boosts |
|---|---|---|---|---|
| `find_decisions` | 0.7 | 0.3 | semantic-text, lexical | `decision/*`, `knowledge/insight` |
| `recall_conversation` | 0.2 | 0.8 | lexical, temporal, proximity | `conversation/turn/*` |
| `debug_session` | 0.1 | 0.9 | numeric (exit_code!=0), lexical, proximity | `process/error_trace`, `code/test_result`, `process/command_output` |
| `find_code` | 0.0 | 1.0 | code-structural, lexical, graph (via produced_by) | `code/*` |
| `visual_recall` | 0.1 | 0.9 | perceptual-image, semantic-image, lexical (OCR) | `media/image/*` |
| `what_we_learned` | 0.6 | 0.4 | semantic-text, graph | `knowledge/*`, `decision/rationale` |
| `entity_lookup` | 0.4 | 0.6 | entity filter (hard) + temporal | any that appears in `entity_refs` |
| `url_lookup` | 0.3 | 0.7 | facet (`kind='reference/link'` or `'document/web_fetch'`) + lexical | `reference/link`, `document/web_fetch` |
| `default` | 0.5 | 0.5 | hybrid across all | none |

Classifier: rules-first (keyword patterns → intent), Haiku fallback if no rule fires with confidence > 0.7. Intent stored in `query_logs` for later review.

## Retrieval pipeline

### Stage 0 — Validation + scope

1. Require `org_id`, `project_id`.
2. Validate `scope` against caller's org access (org-key auth).
3. Resolve `project_id` against `catalog.db`; if `visibility != 'active'` and `include_hidden=false`, reject or 404.
4. Expand `scope='org'` into the list of active projects in that org.

### Stage 1 — Hard filters

SQL WHERE clause built from:

- `org_id`, resolved project list, `visibility='active'` unless `include_hidden`
- `facets.kind_prefix`: `kind GLOB 'prefix/*'` per entry, OR'd
- `facets.origin`, `facets.actor`, `facets.session_id`: equality
- `entities`: `hash IN (SELECT referrer_id FROM entity_refs WHERE entity_id IN (...))` per entity (intersect)
- `numeric`: joined against `artifact_num_meta` per key with operator

Output: candidate hash set (could be millions → we cap at 10⁵ with a sort-by-ts descending cut; callers in deep-search mode opt-in to no cap).

### Stage 2 — Ranked retrievers (parallel)

Each retriever takes (candidate pool, intent-adjusted weight) and returns top-K with raw scores.

1. **Lexical (BM25 via FTS5)** — `SELECT hash, bm25(artifacts_fts) FROM artifacts_fts WHERE artifacts_fts MATCH ? AND project_id IN (...) LIMIT 200`
2. **Semantic text (sqlite-vec)** — embed query with bge-m3, `SELECT hash, distance FROM vec_text WHERE embedding MATCH ? AND k=200` filtered by candidate pool.
3. **Temporal** — if `temporal.near_artifact` set, score by `exp(-|ts - ref_ts| / half_life)` where half_life comes from intent (debug: 5min, recall: 1h, find_code: 24h).
4. **Graph** — BFS/DFS from `graph.seed_hash` up to `graph.depth` following `edge_types`; score by `1/(1 + hops)`. For pre-computed, read `ppr_scores` where `seed_hash = ?`.
5. **Perceptual image** — if `image.phash` set, Hamming-distance search via BK-tree (in-process cache) returning top-K with Hamming < 10.
6. **Semantic image (CLIP)** — if `image.vector_ref` set, resolve to CLIP vector via `vec_clip_map`, cosine search in `vec_clip`.
7. **Code-structural** — if intent is `find_code`, FTS over `code_symbols.symbol` + file_path contains match.
8. **Proximity** — if `near_artifact` set and layers includes archive, compute `|turn_ord - ref.turn_ord|` within same session as a ranker.

Retrievers run on a Node worker pool. Each returns `[(hash, rank, raw_score, retriever_name)]`.

### Stage 3 — Rank Fusion (RRF)

```
score(d) = Σ_m  w_m · 1 / (k + rank_m(d))
```

- `k = 60` (canonical default, robust to score-scale differences)
- `w_m` = intent-weight × user-weight × layer-prior
- Per-layer prior applied to the candidate's layer (archive or thoughts) via its retrievers
- Documents present in only one retriever are NOT penalised; RRF handles sparse-presence fine

Output: top-100 after fusion, sorted desc.

### Stage 4 — Dedup + MMR

- **Simhash dedup**: compute 64-bit simhash per candidate text; cluster by Hamming < 3; keep highest-scored per cluster. Survivors tag `similar_to` pointing at cluster head (not persisted; in-response only).
- **MMR (Maximal Marginal Relevance)**:
  ```
  score_mmr(d) = λ · score(d) - (1-λ) · max_{s∈selected} similarity(d, s)
  ```
  λ = 0.5, similarity = cosine of candidate vectors when available else 0.

Output: top-20 diversified.

### Stage 5 — Cross-encoder rerank (Phase 3+)

- Model: `bge-reranker-v2-m3` local, loaded once in a worker, kept warm.
- Input: (query_text, candidate_summary) per candidate, batched (100 per call).
- Candidate summary is **structured**, not raw text:
  ```
  [kind=decision/record  project=proj_auth  ts=2026-02-14]
  Decided to switch JWT verification to ES256 because RS256...
  ```
- Output: reranker score [0,1]. New ordering. Keep top-`limit` (default 20).

### Stage 6 — Optional LLM rerank (Phase 9+)

- Gate: top-5 fused+reranked RRF score max < `τ_llm` (default 0.35) OR caller sets `rerank.llm='on'`.
- Model: Haiku 4.5.
- Prompt:
  ```
  Rank these N candidates by relevance to: "{query}".
  Return JSON array of {id, rank, justification} sorted best-to-worst.
  Be strict — if no candidate is truly relevant, leave rank=null.
  ```
- Output merged with structured justifications into final response.

### Stage 7 — Confidence floor

- `confidence_score = max(fused_scores) / norm_constant`  (normalised to [0,1])
- If `confidence_score < τ_conf` (default 0.15), response includes `low_confidence: true` plus the top candidates anyway (user decides what to do with them).

## Response shape

```json
{
  "query_id": "01H...",
  "latency_ms": 142.7,
  "confidence_score": 0.68,
  "low_confidence": false,
  "intent_used": "find_decisions",
  "total_candidates": 487,
  "results": [
    {
      "id": "abc123...",
      "layer": "archive",
      "kind": "decision/record",
      "snippet": "Decided to switch JWT verification to ES256...",
      "ts": 1739520000,
      "project_id": "proj_auth",
      "session_id": "sess_9f12",
      "score": 0.83,
      "score_breakdown": {                // only if return_score_breakdown=true
        "bm25":        {"rank": 3, "raw": 9.2, "weight": 0.7},
        "semantic":    {"rank": 1, "raw": 0.89, "weight": 1.0},
        "temporal":    {"rank": null, "raw": null},
        "graph":       {"rank": 5, "raw": 0.4, "weight": 0.5},
        "rrf":         {"rank": 1, "fused": 0.0412},
        "cross_enc":   {"rank": 1, "raw": 0.91},
        "llm":         null
      }
    }
  ],
  "layers_returned": {"archive": 14, "thoughts": 6},
  "debug": {                               // only in admin mode
    "hard_filter_sql": "SELECT ... WHERE ...",
    "retriever_timings_ms": {"bm25": 8, "semantic": 42, "graph": 15, ...}
  }
}
```

## Thresholds (tunable per org)

Stored in `catalog.db.brain_config`:

| Threshold | Default | Meaning |
|---|---|---|
| `rrf_k` | 60 | RRF smoothing constant |
| `mmr_lambda` | 0.5 | Relevance vs diversity |
| `simhash_cluster_dist` | 3 | Hamming distance for near-dup cluster |
| `cross_encoder_topk` | 100 | Cross-encoder rerank input size |
| `final_topk` | 20 | Returned to caller by default |
| `tau_conf` | 0.15 | Confidence floor |
| `tau_llm` | 0.35 | LLM rerank trigger (below this, fire) |
| `half_life_sec.debug` | 300 | Temporal decay for debug intent |
| `half_life_sec.recall` | 3600 | Temporal decay for recall intent |
| `half_life_sec.find_code` | 86400 | Temporal decay for code intent |

## Fan-out across sealed files

Smart routing via `catalog.db`:

1. Load `(project_id, temporal.from, temporal.to)` constraints.
2. Query catalog: `SELECT file_name FROM catalog_files WHERE org_id=? AND project_has_data=1 AND date_range_overlaps=1`.
3. Typical result: 2–4 sealed files + `active.db` → ATTACH those in one connection, union-all per-retriever queries.
4. Deep search (`scope='all_time'` flag or equivalent): worker pool, one connection per sealed file, parallel retriever execution, RRF merge in Node. Budget: 300–800 ms cold, <200 ms warm.

## Rejection cases

- Missing `org_id` or `project_id` → 400.
- `graph.depth > 3` → 400.
- `temporal.from > temporal.to` → 400.
- `facets.kind_prefix` containing unknown top-level branch → 400.
- `entities` referencing entities from another org → 400 (cross-org lookup blocked).
- Empty QuerySpec (no text, no image, no temporal, no graph, no facets, no entities) → 400 "specify at least one retriever or filter".

## Logged to query_logs

Every query, regardless of success/failure:

- `query_spec_json` (input), `intent` (used), `retrievers_json` (per-retriever top-20 with scores), `fused_top_json` (post-RRF top-20), `reranked_top_json` (post-rerank), `chosen_ids_json` (returned to caller), `latency_ms`, `confidence_score`
- `used_ids_json` populated post-hoc if caller reports back which results it used (agent can PATCH `/api/brain/query-logs/:id`).

This is LTR training data for Phase 10.
