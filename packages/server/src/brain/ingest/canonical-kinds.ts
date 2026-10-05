/**
 * Canonical artifact kinds. Mirrors docs/plans/brain/02-taxonomy.md.
 * Used by kind-validator to suppress review-queue noise for well-known kinds.
 *
 * Growth rule: new leaf kinds arriving from a new tool are ACCEPTED at ingest
 * but queued for review. When a reviewer promotes them to canonical, add
 * them here.
 */

export const CANONICAL_KINDS: ReadonlySet<string> = new Set([
  // conversation/
  "conversation/turn/user_message",
  "conversation/turn/assistant_message",
  "conversation/turn/thought",
  "conversation/turn/system_message",
  "conversation/tool_call",
  "conversation/tool_result",
  "conversation/meta/session_start",
  "conversation/meta/session_end",
  "conversation/meta/compaction",
  "conversation/meta/interruption",
  "conversation/meta/resume",

  // code/
  "code/blob",
  "code/blob/ts",
  "code/blob/tsx",
  "code/blob/js",
  "code/blob/jsx",
  "code/blob/py",
  "code/blob/go",
  "code/blob/rs",
  "code/blob/sql",
  "code/blob/sh",
  "code/blob/md",
  "code/blob/json",
  "code/blob/yaml",
  "code/diff",
  "code/file_snapshot",
  "code/commit",
  "code/patch",
  "code/test_result",
  "code/build_output",
  "code/lint_output",
  "code/type_check_output",

  // media/
  "media/image/screenshot",
  "media/image/diagram",
  "media/image/photo",
  "media/image/chart",
  "media/image/terminal_capture",
  "media/video",
  "media/audio",
  "media/canvas_export",

  // document/
  "document/markdown",
  "document/pdf_excerpt",
  "document/web_fetch",
  "document/api_doc_excerpt",
  "document/spec",
  "document/readme",
  "document/claude_md",

  // data/
  "data/json",
  "data/yaml",
  "data/csv",
  "data/table",
  "data/sql_query",
  "data/query_result",

  // decision/
  "decision/record",
  "decision/tradeoff",
  "decision/alternative_considered",
  "decision/rationale",
  "decision/reversal",

  // task/
  "task/task",
  "task/subtask",
  "task/todo",
  "task/blocker",
  "task/milestone",
  "task/retry_attempt",

  // knowledge/
  "knowledge/crumb",
  "knowledge/note",
  "knowledge/question",
  "knowledge/answer",
  "knowledge/insight",
  "knowledge/lesson_learned",
  "knowledge/anti_pattern",
  "knowledge/principle",

  // reference/
  "reference/link",
  "reference/citation",
  "reference/external_resource",
  "reference/person",
  "reference/entity",
  "reference/cross_ref",

  // process/
  "process/command",
  "process/command_output",
  "process/shell_session",
  "process/error_trace",
  "process/stack_trace",
  "process/log_line",

  // workflow/
  "workflow/plan",
  "workflow/strategy_node_snapshot",
  "workflow/iteration_step",
  "workflow/validation_result",
  "workflow/supervision_event",

  // agent/
  "agent/agent_run",
  "agent/subagent_spawn",
  "agent/mcp_call",
  "agent/mcp_result",
  "agent/hook_fire",
]);

export function isCanonicalKind(kind: string): boolean {
  return CANONICAL_KINDS.has(kind);
}
