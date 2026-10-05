# Phase 22 — Brain Graph Redesign: Obsidian-like Viz, Useful Context, Weak-link Pruning

## Why we're doing this

The brain graph (`BrainGraph.tsx`, ~640 LoC, d3-force 2D) is producing
visible-but-useless output right now:

1. **Click a node, get an id and a kind. No project/org/tree position, no
   linked thoughts, no date.**
2. **2D only.** Force layout, but no 3D depth cue that helps separate
   clusters in dense graphs.
3. **No pruning.** Every artifact is a node; an active project ingests
   thousands an hour. The density warning bails at 5000 nodes — that's
   minutes of usage. We need automated weak-link / weak-node pruning.
4. **No "Obsidian-like" affordances** — local-graph mode, filter pane,
   colour groups by folder/tag, edge fade on zoom, hover preview.

This phase: research-grounded plan to make the graph an actually useful
thinking tool — not a force-directed sphere of unlabelled noise.

## Karpathy's "second brain" framework (single most useful reference)

Karpathy maintains a personal wiki by separating **raw** (`raw/`, source
articles + transcripts) from **synthesized** (`wiki/`, interlinked
atomic pages). An LLM agent owns three operations against `wiki/`:

1. **Ingest** — read new raw material once, update/create wiki pages,
   refresh `index.md` (content map of which pages exist), append to
   `log.md`.
2. **Query** — answer questions against the synthesized wiki, **never
   the raw files**, because the pages already carry structure and
   cross-references.
3. **Lint** — maintenance pass: broken links, contradictions, stale
   claims, orphans, concepts deserving standalone pages. Editorial
   work, not "interesting thinking".

Mapping to NoSleep:

| Karpathy | NoSleep | Status |
|---|---|---|
| `raw/` | `artifacts` table (conversation/turn/*, tool_call, code/*, image/*) | ✅ present, growing fast |
| `wiki/` page | `thoughts` table (atomic distilled note, linked) | ✅ schema present |
| `wiki/` cross-links | `thought_refs` + `thought_archive_refs` + `entity_refs` | ✅ schema present, sparsely populated |
| `index.md` (content map) | none | ❌ missing — should be auto-derived from thought topics/entities |
| `log.md` | `ingest_events` + `extractor_runs` | ✅ present |
| Ingest op | `runAutoThoughtExtraction` chain | ✅ active (Haiku model name fixed today) |
| Query op | `brain_search` + MCP retrieval tools | 🟡 partial — still queries raw artifacts heavily |
| Lint op | none | ❌ no de-dup, no orphan removal, no contradiction detection |

**The most important takeaway**: the synthesized layer should be the
default surface — not the raw archive. Today's MCP tools still over-rely
on dumping raw context. See next section.

## No-tree-pull principle (operational rule for every retrieval surface)

User-issued rule, applies repo-wide:

> Never dump a whole tree / list / archive. Update, query, and search
> one node at a time. For "related" queries, use node-pair and
> relationship tools — never bulk pulls.

Current violators in `mcp-gateway/src/actions.ts`:

| Tool | Symptom | Replacement |
|---|---|---|
| `strategy_tree` (line 166) | flattens entire tree, ~700 nodes × multi-line | scope by default (in-progress + N actionable + parent chain); `?full=true` opt-in |
| `memory_list` (line 540) | every memory in org | already paginated by category/project; add `?limit` |
| `session_list` (line 361) | last 20 only (fine), but only 20 | now joined by `session_search` + `session_get` (shipped earlier this session) |
| `alert_list` (line 483) | already supports `limit` (good) | keep |
| `project_list` (line 313) | one org's projects (bounded) | keep |

**The fix matrix** for strategy:

| Need | New tool | What it returns |
|---|---|---|
| "What's the current task and its context?" | `strategy_focus(projectId?)` | The single in-progress node + parent breadcrumb + sibling status + blocking deps. ~10 lines. |
| "What's next?" | `strategy_next` (exists, keep) | One node. |
| "What does X relate to?" | `strategy_related(nodeId, kinds?[dep|sib|child|parent])` | Just the N requested-kind neighbours of one node. |
| "Find tasks about X" | `strategy_search(query, project?, status?, limit?)` | Text + metadata filter; ≤20 hits. |
| "Walk a subtree from here" | `strategy_subtree(nodeId, depth?(1-3))` | Bounded subtree from a specific node. Default depth 2. |
| "Give me everything" | `strategy_tree(full=true)` | Only when explicitly opted in. Default = `strategy_focus`. |

Same pattern applies to brain MCP for thoughts/artifacts: prefer
`thought_get`, `thought_related`, `thought_search` over any
"list-all".

## Reference material (the methods we should borrow)

### 1. Obsidian's graph view

Obsidian's "Graph View" is the canonical reference for personal-knowledge
graph visualisation. Concrete features that work:

- **2D force-directed** by default. WebGL/canvas renderer for ~10k nodes.
- **Local graph** mode: pick a node, show only that node + N hops. Reduces
  cognitive load. The user expects to start from "this thought" not "all
  thoughts".
- **Filter pane**: search box that hides non-matching nodes, plus toggles
  for tags / folders / orphan-nodes / attachments. Each toggle re-renders
  in <100ms.
- **Colour groups**: regex/tag → colour. User-defined. Default groups by
  folder.
- **Display sliders**: text-fade-threshold, node-size-by-degree, line-thickness,
  centre-force, repel-force, link-force, link-distance. These belong in a
  collapsible sidebar.
- **Hover preview**: a one-line snippet of the node's content + its tags.
  Click → opens the note in main pane (or in our case, the detail panel).
- **Smooth zoom**: edges fade out as you zoom out, labels fade in as you
  zoom in (LOD — we have this partly already).
- **Arrowheads** optional: cluttered for our weighted refs; keep off by
  default.

The third-party **Obsidian 3D Graph** plugin (Atomic-Ess) extends this
to 3D via `three-forcegraph`. Same controls + a Z-axis. Useful when
clusters are entangled in 2D.

### 2. Zettelkasten / Evergreen Notes principles

The mental model underneath Obsidian's UX:

- **Atomicity**: one idea per node. Long chats violate this; we already
  do `auto_thought` extraction to lift atomic ideas — that's the right
  primitive.
- **Bidirectional links**: a backlink is as important as a forward link.
  Our `thought_refs` schema supports both; the viz currently treats
  them symmetrically (good).
- **Emergent structure**: don't force taxonomy upfront. Let clusters
  form by link density. Our colour-by-thought-type does this naturally.
- **Maps of Content (MOCs)**: a "hub" note that lists pointers to many
  others. We could synthesise these from strategy-tree-root nodes.

These are conceptual, not implementation. They mostly say "don't pile
up giant artifacts in the graph — keep nodes atomic, lean on the auto-
thought extractor that already exists."

### 3. Weak-link / weak-node pruning techniques

Standard graph operations to keep a knowledge graph readable as it
grows. Each has a cost/benefit relevant to our brain:

| Technique | What it does | Cost | Our fit |
|---|---|---|---|
| **Orphan removal** | Hide nodes with degree 0 | Cheap | Yes — kill isolated artifacts in viz (still in DB) |
| **Edge-weight threshold** | Hide edges below weight W | Cheap | Yes — we already have weight; just expose a slider |
| **Time-decay** | Edge weight × exp(-Δt/τ) | Cheap | Decay refs over months so "recent" thinking is denser than archived |
| **Degree-based pruning** | Drop nodes with degree < K | Cheap | Yes — combine with orphan removal |
| **PageRank trimming** | Keep top-N nodes by PageRank | O(\|E\|·k) iterations | Heavy — only worth it if we hit the hard density limit. d3 doesn't include it; could use [graphology-pagerank](https://github.com/graphology/graphology/tree/master/src/metrics/centrality/pagerank) (npm). |
| **Betweenness centrality** | Find bridge nodes | O(\|V\|·\|E\|) — heavy | Skip for now |
| **K-core decomposition** | Keep only k-core (each node connected to ≥k others in the subgraph) | O(\|V\|+\|E\|) | Good — visualises "the dense backbone" of the graph |
| **Community detection (Louvain)** | Find clusters automatically | O(\|V\|·log\|V\|) | Good colour-by-cluster option |
| **Near-duplicate merge** | Merge nodes with cosine sim > θ | Embedding-bound | We already embed thoughts; could surface "candidates to merge" |

**Practical recommendation**: ship orphan-removal + edge-weight threshold
+ time-decay as user-facing sliders in v1. K-core as a "compact view"
toggle. Skip PageRank/Louvain until ≥20k nodes.

### 4. 3D libraries

The serious options for React + 3D force graphs:

| Lib | Renderer | Pros | Cons |
|---|---|---|---|
| **`react-force-graph` / `3d-force-graph`** | Three.js | Drop-in; same author as 2D `force-graph`; well-maintained; works to ~10k nodes | New dep; Three.js bundle ~600KB gzipped |
| **`react-three-fiber` + custom forces** | Three.js | Total control | We have to reimplement force + interaction |
| **`vis-network`** | Canvas2D | 2D only | Not 3D |
| **`cytoscape.js`** | Canvas2D | Rich algorithms (incl. PageRank) | 2D only |

**Recommendation**: `react-force-graph-3d` (`3d-force-graph` family). It
keeps the d3-force-style API we already have in `BrainGraph.tsx`, but
with a Z-axis and a `ForceGraph3D` React component. Migration is
mechanical: same nodes/links data shape, swap the renderer.

Bundle cost: ~600KB gz. Acceptable for a lazy-loaded brain route.

### 5. What the detail panel must show (the top usability gap)

User said the click-detail shows id + kind and nothing useful. The panel
needs all of:

- **Title / snippet** (first non-empty line of content)
- **Kind + thought_type** (e.g. "thought · decision")
- **Project + org** (resolved name, not id)
- **Strategy node path** if any — "Strategy → Goal → Task" breadcrumb
- **Created at** (relative + absolute)
- **Linked thoughts** (incoming + outgoing) — clickable
- **Source artifacts** for thoughts — clickable
- **Topics / people / action items** for thoughts (we extract these
  already — they're empty in the panel today)

This is a `<BrainNodeDetail>` component that mirrors what `BrainThought.tsx`
already renders, just packed sidebar-side instead of full-page.

## Current implementation — what we have, what we don't

Reading `BrainGraph.tsx` and the API:

| Feature | Present | Notes |
|---|---|---|
| 2D force layout | ✅ | d3-force, manual sim |
| Timeline layout | ✅ | secondary mode |
| Zoom + LOD edge fade | ✅ | `LOD_HIDE_LIGHT_EDGES`, `LOD_SHOW_LABELS` |
| Layer toggles (thoughts / entities / archive) | ✅ | checkboxes |
| Density warning | ✅ | soft / hard limits |
| Focus on a node (URL `?focus=`) | ✅ | recently added |
| Click → selection | ✅ | renders a panel |
| **Detail panel — useful content** | ❌ | id + kind only |
| 3D | ❌ | flat d3-force |
| Local-graph mode (N-hop neighbourhood) | ❌ | shows everything |
| Filter pane (search + tag + orphan toggle) | ❌ | only layer checkboxes |
| Colour-by-cluster / by-project | ❌ | colour is kind/thought-type only |
| Orphan removal | ❌ | nothing hidden |
| Edge-weight slider | ❌ | one hard-coded threshold |
| Time-decay | ❌ | edges have no decay |
| K-core / "compact view" | ❌ | absent |
| Hover preview | ❌ | tooltip is just the label |

So: skeleton is there. Missing: every interaction that turns a sphere of
dots into something you reason against.

## Phased plan (proper sequencing)

Six phases, ordered by dependency + value. Each phase is shippable
on its own — no big-bang. Estimates assume one focused day of work
per "day" estimate.

### Phase A — Detail panel + filter pane + local-graph (no new deps)

**Scope** — usable interactive graph against existing data.

**Estimate** — 1 day.

**Deps** — none.

**Server changes**:

- Extend `/api/brain/graph` node payload: add `project_id`,
  `project_name`, `content_snippet` (first 200 chars), `ts`,
  `degree` (in+out), and for thoughts: `topics`, `people`,
  `action_items`, `dates_mentioned`.

**Web changes**:

- New `<BrainNodeDetail>` sidebar component (right pane, ~360px).
  Renders title (snippet for artifacts; content for thoughts),
  kind/type pill, project+org, breadcrumb to root, created-at
  (relative + abs), topic/people/action chips, linked-thoughts list,
  source-artifacts list. All clickable.
- Filter pane (collapsible left, ~280px): search input (substring),
  project multi-select, kind+thought-type chip toggles, orphan
  toggle ("degree == 0 → hide"), edge-weight slider (0.0-1.0), decay
  slider ("none / 7d / 30d / 90d / all").
- Local-graph mode: "Isolate" button on the detail panel. Slider
  for N-hop (1-4). Hides all nodes farther than N hops.
- Hover tooltip: title + last-modified line.

**Done when**: clicking any node shows full context (project,
breadcrumb, links, chips), filters reduce the visible graph in
<100ms, isolate mode shows just the chosen neighbourhood.

### Phase B — Worktree alignment + session-to-node tagging

**Scope** — fix session attribution so worktree-launched sessions
land in the right project AND get tagged with their strategy node.


**Estimate** — 1 day.

**Deps** — none.

**Server changes**:

- `/api/sessions/register` resolves git common-dir: when the
  `projectPath` arg is a worktree, derive the canonical repo path
  via `git -C <path> rev-parse --git-common-dir` and look up the
  project by that path. Worktree path also stored as `worktree_path`
  on the session row.
- New column `sessions.strategy_node_id` (already partial — verify).
  Auto-loop's `decide-next` already returns the next task's id;
  update the session row with that node id on injection.

**Hook installer**:

- Hook scripts also report `hookData.cwd` to `/register` so the
  server has the runtime cwd, not just the install-time projectPath.

**Web changes**:

- Strategy tree view shows "Active sessions: N" badge per node
  (links to the session detail).
- Session card shows the strategy node title it's currently
  attributed to.

**Done when**: launching `claude` in a worktree of `nosleep` shows
up under "NoSleep" project, with the currently-injected task node
visible on the session card.

### Phase C — Strategy ref-links + strategy graph view

**Scope** — strategy nodes can reference each other beyond
parent/dep edges; visualise the strategy tree as a graph instead of
just a flat list.

**Estimate** — 1.5 days.

**Deps** — Phase B (to render session badges).

**Schema**:

- New table `strategy_node_refs`: `(from_id, to_id, kind, weight,
  created_at)`. `kind` enum: `related`, `informs`, `supersedes`,
  `references`. (Different from `dependencies` which is
  blocking-order.)

**Server**:

- CRUD endpoints `POST /api/strategy/refs`, `DELETE
  /api/strategy/refs/:id`, `GET /api/strategy/node/:id/refs`.
- MCP gateway: `strategy_ref_add`, `strategy_ref_list` tools.

**Web**:

- New `StrategyGraphView`: same renderer as BrainGraph but seeded
  with strategy nodes + their parent/dep/ref edges. Filter by
  project. Side panel uses the same `BrainNodeDetail` pattern
  scoped to strategy nodes.
- Inline "Add ref" UI on node detail.

**Done when**: a user can create cross-tree "related" links between
strategy nodes (across projects too), the strategy graph view
renders them, and clicking traverses both parent/dep and ref
edges.

### Phase D — 3D toggle + colour-by-cluster (Louvain)

**Scope** — opt-in 3D rendering + community-detection colour grouping.

**Estimate** — 1 day.

**Deps** — Phase A.

**New deps**:

- `react-force-graph-3d` (~600KB gz, lazy-loaded so non-brain
  routes don't pay it).
- `graphology` + `graphology-communities-louvain` (~30KB, runs
  once per fetch).

**Web**:

- Layout selector becomes "Force 2D / Force 3D / Timeline".
- Colour-by selector: `kind` (current) / `thought type` / `cluster`
  (Louvain) / `project`.

**Done when**: 3D mode renders the same graph as 2D, rotatable,
performant to ~5k nodes; Louvain cluster colouring is visibly
distinct per community.

### Phase E — Auto-prune: time-decay + K-core + dedup queue

**Scope** — keep the graph readable as the corpus grows.

**Estimate** — 1.5 days.

**Deps** — Phase A (sliders already in place).

**Server**:

- Add `effective_weight` computed in `buildGraph`: `base_weight ×
  exp(-Δdays / 90)` where Δdays = now − edge created_at. Decay tau
  configurable.
- K-core decomposition computed client-side (cheap) on the
  visible subset.
- Background "near-duplicate candidate" job: pairs of thoughts
  with cosine sim > 0.92, surfaced to the existing
  `admin/brain/merge-queue` UI.

**Web**:

- Decay slider on filter pane now active (was placeholder in
  Phase A).
- "Compact view" toggle = K-core ≥ 2.
- Merge queue UI shows "merge / keep both" actions.

**Done when**: decay slider dims old edges; compact view hides
non-core orbital nodes; merge queue has new near-dup candidates
visible on the admin page.

### Phase F — Karpathy lint pass (the editorial loop)

**Scope** — the missing third operation in Karpathy's framework.
Automated maintenance that we currently lack entirely.

**Estimate** — 2 days.

**Deps** — Phase E (uses the same dedup machinery).

**Server**:

- Scheduled `lint` job (cron-style, runs nightly):
  1. Broken-link check: thoughts referencing missing artifact
     hashes or other thoughts → mark visibility=quarantined.
  2. Orphan detection: thoughts with 0 incoming + 0 outgoing
     refs older than 30d → surface to "orphan queue".
  3. Contradiction sniff: pairs of thoughts with similar topics
     but opposite verdicts (Haiku triage). Cheap heuristic, low
     volume.
  4. Stale claim flag: thoughts older than 180d whose source
     artifacts have been superseded.
- `/api/admin/brain/lint/run` + lint-queue admin UI.

**`index.md` generation**:

- Auto-derive an `index.md`-equivalent: top topics by thought
  count, per-project topic clusters, refreshed nightly. Lives in
  a new `brain_index` table. UI: a "Map of content" page on the
  Brain hub.

**Done when**: nightly lint produces actionable queues (orphans,
contradictions, stale claims), the Brain Hub gains a "Map of
Content" view summarising the corpus.

---

## Cross-cutting work (out of phase, but related)

- **MCP "no-tree-pull" tools** — `strategy_search`,
  `strategy_related`, scoped `strategy_tree`. **Shipped this
  session.** Same principle should land for brain MCP
  (`thought_get`, `thought_related`, `thought_search`) — those
  tools partially exist; need an audit pass.

## Order I'd actually ship

A → B → C → D → E → F. A is the most user-facing immediate win
(makes nodes readable). B unblocks the worktree
attribution mess. C is what makes the strategy tree feel like a
real planning tool instead of a flat list. D is the 3D polish. E
prevents corpus rot. F is the editorial discipline.

The earlier draft inline below has the lower-level technique
notes (Obsidian/Zettelkasten/pruning algos); the **phased plan
above is what I'd execute against**.

---

## Earlier draft sections (technique reference — kept for context)

### v1 — usable detail + filters (1-2 days, no new libs)

Highest-leverage, lowest cost. No 3D yet.

1. **Detail panel rewrite**: side panel renders
   `<BrainNodeDetail node={selected} />` with title, kind/type, project+org,
   strategy-node path, timestamp, linked thoughts, source artifacts,
   topic/people/action-item chips. Re-uses logic already in `BrainThought.tsx`.
   Click on a linked thought → set it as the new selected node.
2. **Filter pane** (collapsible left rail):
   - Search box (substring match on label + content snippet)
   - Project filter (multi-select)
   - Kind / thought-type filter (chip toggles)
   - Orphan toggle ("Hide nodes with degree 0")
   - Edge-weight slider (0.0 to 1.0)
   - "Decay older than" slider (none, 7d, 30d, 90d, all)
3. **Local graph mode**: when a node is selected, an "Isolate" button
   filters to N-hop neighbours (slider 1 → 4).
4. **Hover preview tooltip**: one-line snippet + last-modified date.

Server changes: the graph endpoint already returns enough fields for
most of this. Add `project_name`, `strategy_path`, and the thought
metadata (topics/people/action_items) to each node — single SQL
extension.

### v2 — 3D + colour groups (2-3 days, +1 dep)

5. **Add `react-force-graph-3d`** as an opt-in toggle next to
   "Force / Timeline" (becomes "Force 2D / Force 3D / Timeline"). Lazy
   load to keep the bundle off the non-brain shell.
6. **Colour-by-cluster**: use Louvain community detection from
   `graphology-communities-louvain` (cheap, runs once per fetch).
   Assign one colour per community. Toggle "colour by: kind / thought
   type / cluster / project".

### v3 — automated pruning (longer; behavioural)

7. **Time-decay edges**: `effective_weight = base_weight × exp(-Δdays / 90)`.
   Apply at viz time only — DB unchanged.
8. **Background "near-duplicate" candidate detector**: nightly job that
   compares thought embeddings (we have them); surfaces pairs with
   cosine sim > 0.92 to a "merge queue" admin view (already exists).
9. **K-core view**: toggle to render only the k=2 (or higher) core —
   the dense backbone, with everything orbital hidden.
10. **PageRank-based scaling**: node radius proportional to PageRank
    score within the visible subgraph. Computed via
    `graphology-pagerank` on the fetched subset.

## What I'd ship first if you say go

Just v1 (steps 1-4). Everything is interactive UI on data we already
have, no new deps, no schema changes. The biggest user-facing
improvement is the detail panel — that alone turns opaque ids into
"clickable, contextual nodes".

The 3D + clustering (v2) is a satisfying follow-up but doesn't fix the
core complaint that the graph isn't readable yet.

## Defaults chosen

- Linked thoughts in the detail panel re-centre the graph on click.
- Time-decayed edges are dimmed, not hidden.
- 3D is an opt-in toggle; 2D stays the default.

---

## Implemented status (2026-10-05) — sleep-time consolidation + scheduled dedup

Shipped (server + web + brain MCP), covering the pruning half of Phase E and
the first slice of Phase F. Graph-side items (edge decay slider, K-core
compact view) and the rest of the F lint pass are NOT done.

- **Consolidator** — `packages/server/src/brain/jobs/thought-consolidator.ts`.
  Soft-archives (`visibility = 'archived'`, never deletes) thoughts that are
  (a) the target of a `supersedes` ref from an active thought, or (b)
  unrecalled for `stale_days` (default 90) and older than that. Protected:
  pinned (`pinned_at`, migration 014), linked to a live strategy node, or
  (stale rule) referenced by a thought captured/recalled inside the window.
  Thoughts that predate recall tracking (migration 013) get a full grace
  period from the date tracking started. Capped per run (default 500).
  Every run (dry or real) is recorded in `brain_session_events` as
  `thought_consolidation_run` with the ids.
- **Schedule** — `packages/server/src/brain/jobs/maintenance.ts`, called from
  the supervision loop's 30-min housekeeping tick (same tick as telemetry
  retention). Self-gates to once per ~23h per org, persisted via
  `brain_maintenance_run` events. Runs thought-dedup proposals (no
  auto-merge) then the consolidator. No LLM calls. Env:
  `NOSLEEP_BRAIN_MAINTENANCE=0`, `NOSLEEP_BRAIN_DEDUP_NIGHTLY=0`,
  `NOSLEEP_BRAIN_CONSOLIDATE=on|dry-run|off`, `NOSLEEP_BRAIN_CONSOLIDATE_DAYS`,
  `NOSLEEP_BRAIN_CONSOLIDATE_MAX`.
- **Retrieval** — archived thoughts drop out of FTS/list/semantic/related/
  stats via the existing `visibility = 'active'` filters. `include_archived`
  added to `/api/brain/thoughts/search`, `/api/brain/thoughts` (list),
  QuerySpec (semantic retriever) and the brain MCP `search_thoughts` /
  `list_thoughts`. `GET /api/brain/thoughts/:id` always returns them.
- **Reverse** — `POST /api/brain/thoughts/unarchive {org_id, ids, pin?}` or
  MCP `unarchive_thoughts` (pins by default so the next sweep keeps it).
  SQL fallback: `UPDATE thoughts SET visibility='active', pinned_at=strftime('%s','now') WHERE id IN (...) AND visibility='archived';`
- **Admin** — `POST /api/brain/admin/thought-consolidation/run {org_id, dry_run}`,
  `GET /api/brain/admin/thought-consolidation/runs?org_id=`; thought
  near-dup review tab on the Merge Queue page.
- **Dedup fixes** — KNN k raised 3 → 16 (artifacts crowded thoughts out of
  the neighbour set), neighbours restricted to active thoughts in the org,
  event-loop yields between KNN scans.

Still open: contradiction detection, orphan queue, broken-link quarantine,
map-of-content, and anything that improves ranking quality as the active
corpus grows (archiving only shrinks it at the 90-day horizon).
