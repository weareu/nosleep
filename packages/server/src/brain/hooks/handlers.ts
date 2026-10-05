/**
 * Hook-payload → IngestRequest translators. One per hook type Claude Code
 * fires. Each returns zero-or-more ingest requests to be pushed through the
 * brain pipeline.
 */

import type { IngestRequestT } from "../ingest/types.js";

interface BaseHookPayload {
  orgId?: string;
  sessionId?: string;
}

export interface UserPromptPayload extends BaseHookPayload {
  prompt?: string;
  projectId?: string;
  turnOrd?: number;
  actor?: string;
  toolVersion?: string;
}

export interface PreToolPayload extends BaseHookPayload {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  projectId?: string;
  turnOrd?: number;
  actor?: string;
  toolVersion?: string;
}

export interface PostToolPayload extends BaseHookPayload {
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  projectId?: string;
  turnOrd?: number;
  actor?: string;
  toolVersion?: string;
}

export interface PreCompactPayload extends BaseHookPayload {
  summary?: string;
  projectId?: string;
  actor?: string;
  toolVersion?: string;
}

export interface StopPayload extends BaseHookPayload {
  stopReason?: string;
  projectId?: string;
  actor?: string;
  toolVersion?: string;
}

/** Shared origin block; actor/version may be unset on the older hook routes. */
function originOf(p: BaseHookPayload & { actor?: string; toolVersion?: string }) {
  return {
    tool: "claude-code",
    version: p.toolVersion,
    actor: p.actor,
  };
}

export function fromUserPrompt(p: UserPromptPayload): IngestRequestT[] {
  if (!p.orgId || !p.projectId || !p.prompt) return [];
  return [
    {
      kind: "conversation/turn/user_message",
      content: p.prompt,
      content_type: "text/plain",
      org_id: p.orgId,
      project_id: p.projectId,
      session_id: p.sessionId,
      turn_ord: p.turnOrd,
      origin: originOf(p),
      kind_specific_meta: { word_count: p.prompt.split(/\s+/).length },
      schema_version: 1,
    },
  ];
}

export function fromPreTool(p: PreToolPayload): IngestRequestT[] {
  if (!p.orgId || !p.projectId || !p.toolName) return [];
  return [
    {
      kind: "conversation/tool_call",
      content: JSON.stringify({
        tool_name: p.toolName,
        tool_input: p.toolInput ?? {},
      }),
      content_type: "application/json",
      org_id: p.orgId,
      project_id: p.projectId,
      session_id: p.sessionId,
      turn_ord: p.turnOrd,
      origin: originOf(p),
      kind_specific_meta: {
        tool_name: p.toolName,
        tool_input_keys: Object.keys(p.toolInput ?? {}),
      },
      schema_version: 1,
    },
  ];
}

export function fromPostTool(p: PostToolPayload): IngestRequestT[] {
  if (!p.orgId || !p.projectId || !p.toolName) return [];

  const results: IngestRequestT[] = [];
  const base = {
    content_type: "text/plain",
    org_id: p.orgId,
    project_id: p.projectId,
    session_id: p.sessionId,
    turn_ord: p.turnOrd,
    origin: originOf(p),
    schema_version: 1 as const,
  };

  const resultText = p.toolResult ?? "";

  // Per-tool specialised artifact construction
  switch (p.toolName) {
    case "Write":
    case "Edit": {
      const filePath = (p.toolInput?.file_path as string) ?? "";
      const isWrite = p.toolName === "Write";
      results.push({
        ...base,
        kind: "code/diff",
        content: resultText,
        kind_specific_meta: {
          file_path: filePath,
          operation: p.toolName,
          is_new_file: isWrite,
        },
      });
      break;
    }
    case "Read": {
      const filePath = (p.toolInput?.file_path as string) ?? "";
      results.push({
        ...base,
        kind: "code/file_snapshot",
        content: resultText,
        kind_specific_meta: {
          file_path: filePath,
          line_count: resultText.split("\n").length,
        },
      });
      break;
    }
    case "Bash": {
      const command = (p.toolInput?.command as string) ?? "";
      results.push({
        ...base,
        kind: "process/command_output",
        content: resultText,
        kind_specific_meta: {
          command,
          output_length: resultText.length,
        },
      });
      break;
    }
    case "WebFetch": {
      const url = (p.toolInput?.url as string) ?? "";
      results.push({
        ...base,
        kind: "document/web_fetch",
        content: resultText,
        content_type: "text/markdown",
        kind_specific_meta: {
          url,
          prompt: p.toolInput?.prompt,
        },
      });
      break;
    }
    default: {
      // Generic tool_result
      results.push({
        ...base,
        kind: "conversation/tool_result",
        content: resultText,
        kind_specific_meta: {
          tool_name: p.toolName,
          truncated: resultText.length >= 100_000,
        },
      });
    }
  }

  return results;
}

export function fromPreCompact(p: PreCompactPayload): IngestRequestT[] {
  if (!p.orgId || !p.projectId || !p.summary) return [];
  return [
    {
      kind: "conversation/meta/compaction",
      content: p.summary,
      content_type: "text/plain",
      org_id: p.orgId,
      project_id: p.projectId,
      session_id: p.sessionId,
      origin: originOf(p),
      kind_specific_meta: { summary_length: p.summary.length },
      schema_version: 1,
    },
  ];
}

export function fromStop(p: StopPayload): IngestRequestT[] {
  if (!p.orgId || !p.projectId) return [];
  return [
    {
      kind: "conversation/meta/session_end",
      content: p.stopReason ?? "normal_exit",
      content_type: "text/plain",
      org_id: p.orgId,
      project_id: p.projectId,
      session_id: p.sessionId,
      origin: originOf(p),
      kind_specific_meta: { stop_reason: p.stopReason ?? "normal_exit" },
      schema_version: 1,
    },
  ];
}
