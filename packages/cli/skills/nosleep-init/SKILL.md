---
name: nosleep-init
description: Register the current project in NoSleep and load its strategy/plan docs into the live strategy tree. Use when starting a new project, when a strategy/plan markdown exists but isn't in NoSleep, or when the user says "load this into NoSleep". A strategy written only to markdown is NOT done — done means it's visible in the NoSleep web dashboard.
---

# NoSleep Project Init

NoSleep is the autonomous orchestrator at `http://localhost:3777` (web dashboard
at `http://localhost:5173`). It tracks projects, strategy trees, sessions, and
budgets across isolated, user-defined orgs. Never assume org ids — discover them
with `nosleep(action="org_list")` (or `GET /api/orgs`).

## The contract (why this skill exists)

**Writing a strategy to `docs/strategy/*.md` and telling the user to "load it
into NoSleep" is a failure.** The markdown is the source document; the NoSleep
strategy tree is the system of record for execution. Both must exist, and the
tree must reference the doc (`sourceRef`). Done = the tree is visible via
`nosleep(action="strategy_tree")` / the web dashboard — not "the doc exists".

## Prerequisites

- The `nosleep` MCP server is configured globally in `~/.claude.json`
  (`{"type":"http","url":"http://localhost:3777/api/mcp"}`) — available in every
  project. If the `nosleep` tool is missing, check that config and that the
  server is up: `curl -s http://localhost:3777/health`.
- REST calls (needed only for bulk tree creation) require the
  `x-api-key` header. The key is `NOSLEEP_API_KEY` in
  the NoSleep repo's `.env`.

## Steps

### 1. Check registration

```
nosleep(action="project_list", params={orgId: "<org>"})
```

Get the org ids from `nosleep(action="org_list")` and check every org if unsure.
Pick the org by ownership (which client/company the work belongs to), not by
directory. If the owning org doesn't exist yet, create it with
`nosleep(action="org_create", params={name: "<Org Name>"})` (sessions bound to
an org can't — then ask the user to add it in Settings → Organizations). Only
ask the user if genuinely ambiguous.

### 2. Register if missing

```
nosleep(action="project_create", params={
  orgId, name, path: "<absolute repo path>",
  tokenBudget: 500000, autonomyLevel: "supervised"
})
```

Honor any "Project config" block in the project's strategy doc (autonomy,
budget, goal).

### 3. Load strategy docs into the tree

Look for `docs/strategy/*.md`, `docs/plans/*.md`, `PLAN.md`. For each strategy
doc not yet in the tree (check with `nosleep(action="strategy_tree")` /
`strategy_search`):

- **Simple flat plans** (`##` headings = tasks): use
  `nosleep(action="plan_ingest", params={projectId, filePath})`.
- **Nested trees** (bullet hierarchies, phases with subtasks): build the full
  nested structure in one call — `POST /api/strategy/tree`:

```bash
curl -s -X POST http://localhost:3777/api/strategy/tree \
  -H "content-type: application/json" -H "x-api-key: $NOSLEEP_API_KEY" \
  -d '{"projectId":"...","orgId":"...","tree":{
    "type":"strategy","title":"<root>","description":"<goal>",
    "children":[{"type":"goal","title":"...","children":[
      {"type":"task","title":"...","description":"...","priority":true}
    ]}]}}'
```

Schema per node: `type(strategy|goal|task|subtask), title, description?,
acceptanceCriteria?[], weight?, priority?(boolean), children?[]`.

Mapping conventions from doc tags:
- ✅ done → after creation, `strategy_update` → `completed`
- 🔴 WAIT / blocked-on-person → `strategy_update` → `blocked`, person in description
- 🟢 NOW → `priority: true`, leave `pending`
- 🟡 SOON → `pending`, unblock condition in description
- "after X" ordering → add a dependency:
  `POST /api/strategy/node/:id/dependency {"targetId":"<X id>","type":"FS"}`
- Use `strategy_batch_update` for bulk status changes.

### 4. Verify (mandatory)

```
nosleep(action="strategy_tree", params={projectId, full: true})
nosleep(action="strategy_next", params={projectId})
```

`strategy_next` must return a real, correctly-prioritized task. Tell the user
the tree is live in the dashboard and what the next actionable node is.

### 5. Keep them in sync

When a strategy doc changes later, update the tree in the same turn (add/skip/
complete nodes) — the doc and the tree ship together, like code and docs.
