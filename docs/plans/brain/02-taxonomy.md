# NoSleep Brain — Artifact Kind Taxonomy

> Path-typed hierarchical strings. Prefix-queryable. Extensible without schema churn. Every artifact carries one `kind` value matching this hierarchy.

## Rules

- `kind` is a slash-separated path: `top/middle/leaf` (1–4 levels).
- Prefix queries work via `WHERE kind LIKE 'conversation/%'` and via FTS5 token prefixing (we index `kind` segments as tokens for fast prefix match).
- Unknown kinds from a new ingest source are **accepted** (no reject) but land in a `catalog.db` review queue: `kind_review_queue(kind, first_seen_ts, sample_hash, count)`. Admin promotes to canonical or renames.
- Locked-core branches are below. Additions within locked branches are additive and safe. New top-level branches require a schema version bump.

## Locked-core branches

### `conversation/`

| Kind | Description | Kind-specific meta keys |
|---|---|---|
| `conversation/turn/user_message` | A user's prompt to the agent | `role`, `word_count` |
| `conversation/turn/assistant_message` | Agent's response text | `model`, `token_in`, `token_out`, `stop_reason` |
| `conversation/turn/thought` | Extended thinking block | `model`, `token_count` |
| `conversation/turn/system_message` | System-side injection (goal, supervision) | `source` (e.g. 'supervision'), `token_count` |
| `conversation/tool_call` | A tool-use call from the agent | `tool_name`, `tool_input_keys[]`, `call_id` |
| `conversation/tool_result` | Result of a tool call | `call_id`, `is_error` (bool), `truncated` (bool) |
| `conversation/meta/session_start` | Session boot marker | `agent`, `model`, `goal`, `project_id` |
| `conversation/meta/session_end` | Session close marker | `stop_reason`, `duration_sec`, `tokens_total` |
| `conversation/meta/compaction` | PreCompact snapshot | `pre_compact_tokens`, `summary_hash` (linked artifact) |
| `conversation/meta/interruption` | User interrupt | `reason` |
| `conversation/meta/resume` | Session resume | `resumed_from_session` |

### `code/`

| Kind | Description | Kind-specific meta |
|---|---|---|
| `code/blob` | Standalone code snippet | `language`, `line_count` |
| `code/blob/{ts,py,go,rs,sql,sh,md,json,yaml,...}` | Language-tagged variant | same |
| `code/diff` | Unified diff | `files_changed`, `lines_added`, `lines_removed`, `source_tool` |
| `code/file_snapshot` | Full file content at a point in time | `file_path`, `language`, `line_count`, `git_ref` |
| `code/commit` | Git commit | `sha`, `message`, `author`, `files_changed` |
| `code/patch` | Standalone patch not yet applied | `target_path`, `pending` (bool) |
| `code/test_result` | Test run output | `framework`, `passed`, `failed`, `duration_ms` |
| `code/build_output` | Build logs | `tool` (`npm`/`cargo`/`go`), `success` (bool), `duration_ms` |
| `code/lint_output` | Lint run | `tool`, `errors`, `warnings` |
| `code/type_check_output` | tsc/mypy/etc | `tool`, `errors`, `success` |

### `media/`

| Kind | Description | Kind-specific meta |
|---|---|---|
| `media/image/screenshot` | Screen capture | `app_source`, `has_text` (bool) |
| `media/image/diagram` | Diagram / architecture sketch | `has_text` |
| `media/image/photo` | Camera photo | `exif_date`, `camera`, `gps` |
| `media/image/chart` | Chart/graph | `has_data_labels` |
| `media/image/terminal_capture` | Terminal screenshot | `shell`, `has_error` |
| `media/video` | Video (URL ref only; no binary) | `duration_sec`, `source_url` |
| `media/audio` | Audio (voice capture, etc.) | `duration_sec`, `transcript_hash` (linked) |
| `media/canvas_export` | Canvas/drawing export | `format` |

### `document/`

| Kind | Description | Kind-specific meta |
|---|---|---|
| `document/markdown` | Markdown doc | `title`, `word_count`, `heading_count` |
| `document/pdf_excerpt` | Single page of PDF | `page_number`, `pdf_title`, `parent_url` |
| `document/web_fetch` | Fetched web page | `final_url`, `status`, `content_type`, `language`, `author`, `published_at` |
| `document/api_doc_excerpt` | API doc fragment | `api_name`, `endpoint` |
| `document/spec` | Spec / RFC | `title`, `version` |
| `document/readme` | README | `repo` |
| `document/claude_md` | CLAUDE.md content | `project_id`, `scope` (user/project) |

### `data/`

| Kind | Description | Kind-specific meta |
|---|---|---|
| `data/json` | JSON blob | `root_type` (`object`/`array`), `key_count` |
| `data/yaml` | YAML config | same |
| `data/csv` | CSV data | `row_count`, `col_count` |
| `data/table` | Tabular result | `rows`, `cols`, `source` |
| `data/sql_query` | SQL text | `dialect` |
| `data/query_result` | Query result rows | `rows`, `duration_ms`, `linked_query_hash` |

### `decision/`

| Kind | Description | Kind-specific meta |
|---|---|---|
| `decision/record` | A decision made | `decision_type` (e.g. 'technical'/'product'), `reversible` (bool) |
| `decision/tradeoff` | Tradeoff analysis | `options_considered` |
| `decision/alternative_considered` | Option that wasn't chosen | `chosen_instead_hash` |
| `decision/rationale` | Why-doc | `decision_hash` |
| `decision/reversal` | Reversal of a prior decision | `reverses_hash` |

### `task/`

| Kind | Description | Kind-specific meta |
|---|---|---|
| `task/task` | Discrete task | `status`, `assignee`, `due_date` |
| `task/subtask` | Under a task | `parent_hash` |
| `task/todo` | Inline TODO | `file_path`, `line` |
| `task/blocker` | Blocker note | `blocked_by` |
| `task/milestone` | Milestone marker | `date` |
| `task/retry_attempt` | Retry of a failed action | `attempt_n`, `prior_failure_hash` |

### `knowledge/`

| Kind | Description | Kind-specific meta |
|---|---|---|
| `knowledge/crumb` | Small note / breadcrumb | |
| `knowledge/note` | Standalone note | |
| `knowledge/question` | Open question | `answered_by_hash` |
| `knowledge/answer` | Answer | `answers_hash` |
| `knowledge/insight` | Insight / learning | |
| `knowledge/lesson_learned` | Lesson from failure | `from_incident_hash` |
| `knowledge/anti_pattern` | Thing to avoid | |
| `knowledge/principle` | Principle / guideline | |

### `reference/`

| Kind | Description | Kind-specific meta |
|---|---|---|
| `reference/link` | URL reference (captured via URL capture) | `url`, `normalized_url`, `title`, `description`, `og_image_hash`, `domain` |
| `reference/citation` | Citation within text | `cited_by_hash`, `target_url` |
| `reference/external_resource` | External resource metadata | `source`, `kind_hint` |
| `reference/person` | Person reference (also resolves to entity) | `entity_id` |
| `reference/entity` | Generic entity reference | `entity_id` |
| `reference/cross_ref` | Cross-reference to another artifact | `target_hash`, `note` |

### `process/`

| Kind | Description | Kind-specific meta |
|---|---|---|
| `process/command` | Command string | `shell`, `cwd` |
| `process/command_output` | Command output | `exit_code`, `duration_ms`, `shell`, `cwd`, `command_hash` (linked) |
| `process/shell_session` | Full shell session | `shell`, `duration_sec` |
| `process/error_trace` | Error with traceback | `language`, `error_type` |
| `process/stack_trace` | Stack trace only | `language` |
| `process/log_line` | Single log line | `level`, `source`, `timestamp` |

### `workflow/`

| Kind | Description | Kind-specific meta |
|---|---|---|
| `workflow/plan` | Plan document | `phase_count` |
| `workflow/strategy_node_snapshot` | Snapshot of a forward-plan node at a point in time | `strategy_node_id`, `status_at_snapshot`, `progress_at_snapshot` |
| `workflow/iteration_step` | Single iteration step result | `iteration_id`, `step_name`, `success` |
| `workflow/validation_result` | Completeness validator output | `score`, `passed` (bool), `validator` |
| `workflow/supervision_event` | Supervision-loop event | `event_subtype`, `session_id` |

Note: `workflow/strategy_node_snapshot` points back to NoSleep's mutable `strategy_nodes` table via `strategy_node_id`. Strategy nodes themselves are forward-looking and mutable — they live outside the brain's append-only domain. Snapshots preserve the historical state.

### `agent/`

| Kind | Description | Kind-specific meta |
|---|---|---|
| `agent/agent_run` | An agent invocation | `agent_id`, `model`, `duration_sec`, `tokens_total` |
| `agent/subagent_spawn` | Subagent launch | `parent_session`, `subagent_type`, `task_hash` |
| `agent/mcp_call` | MCP tool call | `server`, `tool`, `duration_ms` |
| `agent/mcp_result` | MCP tool result | `server`, `tool`, `call_id`, `is_error` |
| `agent/hook_fire` | Hook event | `hook_type`, `session_id`, `duration_ms` |

## Embed allowlist (default)

Kinds that get dense text embeddings by default:

- All of `conversation/turn/user_message`, `conversation/turn/assistant_message`, `conversation/turn/thought`
- `code/blob`, `code/diff`, `code/file_snapshot` (first 2KB only for large files)
- All of `knowledge/*`, `decision/*`
- `document/markdown`, `document/web_fetch`, `document/pdf_excerpt`, `document/spec`, `document/readme`
- `reference/link` (title + description only, not full fetched content)

FTS-only (no dense embedding) by default:

- `conversation/tool_result`, `conversation/tool_call`
- `process/command_output`, `process/log_line`, `process/stack_trace`
- `code/build_output`, `code/lint_output`
- `data/*` (query FTS + numeric metadata)
- `agent/*` events

Never embed (structural only):

- `conversation/meta/*`
- `code/commit`, `code/patch`
- `media/*` (uses CLIP vectors via separate pipeline)

Per-project override available via `/admin/brain/config`.

## Prefix query examples

- "find all decisions": `kind LIKE 'decision/%'` + FTS text
- "find all screenshots": `kind LIKE 'media/image/screenshot'`
- "find all failed commands": `kind = 'process/command_output' AND exit_code != 0` (via `artifact_num_meta`)
- "find conversation turns this week": `kind LIKE 'conversation/turn/%' AND ts > now-7d`

## Growth escape hatch

New kinds arriving from unknown tools:

1. Ingest accepts the row; `kind` stored as-is.
2. Ingest emits an entry into `catalog.db.kind_review_queue`.
3. Admin UI surfaces queue; admin either approves (promotes to canonical with optional rename) or declines (the kind stays, but is flagged as non-canonical and excluded from intent-aware boosts by default).
4. Schema never has to change for new leaf kinds — only for new top-level branches.

## FTS5 tokenisation note

To support prefix queries like `conversation/tur*`, `kind` is indexed as a text column in `artifacts_fts` (see `01-schema.sql`). The porter tokenizer handles segment-by-segment matching when query uses `kind:*` syntax.
