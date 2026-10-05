# Known Issues & Limits

Honest list of what doesn't work well yet. NoSleep runs daily on one Mac;
everything below was observed there unless stated otherwise.

## 1. It spends your Claude plan in the background

The server makes its own headless Claude calls (`claude` CLI / Agent SDK) on
**your** subscription, independent of any session you're running:

| Caller | When it fires |
|---|---|
| Brain auto-thought extractor | Distils thoughts from captured session turns |
| Brain metadata / vision extractors | Tags artifacts, describes images |
| Thought-ref proposer | Proposes links between thoughts |
| Completeness validator | When an orchestrated session exits |
| Question responder | When an orchestrated session asks a question |

These share your plan's session and weekly limits, so a busy brain can push
your interactive sessions into "You've hit your session limit". The only
guard is a per-minute circuit breaker (soft 60/min, hard 200/min). That stops
runaway loops but is far too loose to protect a Pro/Max quota. **There is no
daily or per-cycle cap on background calls yet.**

Mitigations today:

- **Route background AI to a local model** (Ollama, LM Studio, llama.cpp,
  vLLM) or OpenRouter, per purpose:
  `NOSLEEP_LLM_PROVIDER_BRAIN=openai`, `NOSLEEP_LLM_MODEL_BRAIN=qwen2.5:7b-instruct`.
  See [deployment.md](deployment.md#local--alternative-models).
- `NOSLEEP_BRAIN_DISABLE_TRIAGE=1` in `.env` turns off brain LLM extraction
  (capture and search still work; thoughts aren't auto-distilled).
- Lower `NOSLEEP_BRAIN_SOFT_LIMIT` / `NOSLEEP_BRAIN_HARD_LIMIT` (per minute).
- Stop the server when you don't need it
  (`node scripts/install.mjs --uninstall-service`, or `launchctl bootout`).
- After repeated failures, a headless circuit opens for 10 minutes and logs
  `[headless-claude] circuit OPEN`. That's a symptom of quota exhaustion, not a
  bug to retry through.

### Local-model caveats

- **Quality:** models under ~7B often return unparseable JSON for brain
  extraction. Those items are skipped (`[auto-thought] unparseable verdict`),
  so fewer thoughts are captured. Keep the validator on Claude unless you use
  a model of ~30B or larger.
- **Vision is off** when openai is selected without `NOSLEEP_LLM_MODEL_VISION`.
  Set a vision model, or `NOSLEEP_LLM_PROVIDER_VISION=claude`.
- **Responder cold start:** the 15s timeout can miss on a cold local model
  (it then defaults to "continue"). Raise `NOSLEEP_LLM_TIMEOUT_MS_RESPONDER`.

## 2. It adds to your sessions' context

Each hooked session pays context for NoSleep:

- **Pre-tool messages:** budget warnings, supervision/steering messages and
  human escalation answers are injected on tool calls.
- **Goal re-injection:** every N tool calls and after every compaction.
- **Recall on launch:** up to 3 memory rows and 5 brain thoughts (snippets).
- **The `nosleep` MCP tool:** one tool with ~50 actions. Its description and
  results add tokens. `strategy_tree` defaults to a focused view; avoid
  `full: true` on big trees.

None of this is budgeted against the session's context window yet. On long
sessions, expect earlier compaction than without NoSleep.

## 3. Storage grows without bound

- The main DB and brain archive only grow. The author's main DB is ~0.9 GB
  after a few months. WAL is capped (64 MB journal limit) and ingest pauses
  below 5 GB free disk (`NOSLEEP_MIN_FREE_DISK_GB`) instead of crashing.
  Nothing is ever deleted.
- The graph view loads the newest 500 thoughts (max 1200). Older thoughts
  aren't in the graph even though search still finds them.

## 4. Memory rot at scale (open problem)

As the Brain grows, it gets harder to find the right memory. "Rot" covers
three different failures:

| Kind | What it looks like | Status |
|---|---|---|
| **(a) Retention** | Useless or duplicate memories pile up; useful ones get buried | Partly addressed. Daily soft-archive of stale and superseded thoughts, plus nightly near-duplicate proposals |
| **(b) Staleness / contradiction** | An old fact is still retrieved after a newer one replaced it | Weak. `supersedes` links exist; the consolidator archives superseded thoughts. No contradiction detection |
| **(c) Retrieval degrades with size** | Hybrid search returns plausible but wrong neighbours as the corpus grows | **Not addressed.** No benchmark measures recall quality over time |

What runs today:

- Search and retrieval only return `active` thoughts. Merged or archived
  ones are hidden but kept.
- `last_recalled_at` is stamped whenever a thought is read or retrieved.
- **Sleep-time consolidator** (daily, per org, no LLM calls). It soft-archives
  thoughts not recalled for 90 days, plus thoughts superseded by an active
  thought. It caps at 500 per run, never deletes, and skips pinned thoughts
  and thoughts linked to a live strategy node or a recent thought. Undo with
  `POST /api/brain/thoughts/unarchive` or the `unarchive_thoughts` MCP tool.
  Searches take `include_archived`.
- **Nightly near-duplicate proposals** (embedding cosine > 0.92, newest 500
  per org). They are reviewed by a human in Brain Admin → Merge Queue →
  *Thought near-duplicates*, never auto-merged.
- Tuning: `NOSLEEP_BRAIN_MAINTENANCE=0` turns both off.
  `NOSLEEP_BRAIN_CONSOLIDATE=on|dry-run|off`, `NOSLEEP_BRAIN_CONSOLIDATE_DAYS`,
  `NOSLEEP_BRAIN_CONSOLIDATE_MAX`, `NOSLEEP_BRAIN_DEDUP_NIGHTLY=0`.

Why that's **not enough**: classic statistical pruning (age, recall count,
cosine-dedup) treats every memory the same. A wrong thought that keeps being
recalled is never archived; recall-stamping can even reinforce it.
Supersession only works when someone adds a `supersedes` link. Ranking has
no recency weighting, so the active set still grows without bound.
Nor does it know when a decision was reversed, that two thoughts disagree, or that a rarely-recalled thought is
the one that matters. Archiving shrinks the pile, but it doesn't make
retrieval *correct*. Open work:

- A retrieval-quality eval (fixed question set, tracked as the corpus grows),
  so rot is measured instead of guessed.
- Contradiction / supersession detection at write time (when a new thought
  lands, find what it replaces).
- Strategy-tree-anchored retention: keep what live tasks reference, demote
  what only finished branches referenced.
- Nightly lint (plan 22 Phase F): broken links, orphans, stale claims, plus a
  "map of content" index page. Not started.

Ideas and PRs are very welcome here. It's the main unsolved problem.

## 5. Dashboard navigation gaps

- Strategy graph (`/strategy/graph`): now linked from the Strategy page. It
  still shows no live-session badges on tree nodes.
- Brain node detail shows the raw strategy node id, not a
  Strategy → Goal → Task breadcrumb, and no org name.
- Graph filters: no per-project multi-select or thought-type chips. Louvain
  "cluster" colouring only works in 3D (2D falls back to kind).
- The web UI has almost no automated tests.

## 6. Hooks installed before 2026-10-05 drop tool results

Older generated `post-tool.mjs` hooks read `tool_result`, but Claude Code sends
`tool_response`. Tool results never reached the Brain, and large results
could be rejected with a 400. Fixed in the installer. **Reinstall hooks** in
existing projects (dashboard → Projects → Install hooks) to pick it up.

## 7. Platform and scope limits

- **Orgs are fixed** to three slots (`personal`, `wyobi`, `apply`). They're
  baked into the DB schema; renaming or adding orgs needs a migration that
  doesn't exist yet.
- **Single machine.** One server, one SQLite DB, no multi-user auth model.
  The server listens on `0.0.0.0` for the phone, so keep it on a trusted LAN or
  Tailscale.
- **Windows** is beta (WSL2 recommended). The menu bar app is macOS-only.
  **Android** is beta.
- **CLI wrapper:** POSIX-only (python3 pty). It needs per-project hooks and an
  existing `.claude/` directory, and chains only one follow-up task. See
  [cli.md](cli.md).
- **OpenCode:** hooks, MCP and auto-capture work. Loops still relaunch in
  Claude Code, assistant replies aren't archived, and there's no
  AskUserQuestion auto-answer. See [opencode.md](opencode.md).
