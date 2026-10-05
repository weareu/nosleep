import type { StreamMessage } from "./claude-cli.js";
import { STUB_PATTERNS } from "@nosleep/shared";

export interface ParsedResult {
  readonly costUsd: number;
  readonly durationMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly model: string;
  readonly claudeSessionId: string | null;
  readonly numTurns: number;
}

export interface ParsedToolUse {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface ParsedToolResult {
  readonly name: string;
  readonly result: string;
}

/**
 * Detects if a session is asking a question / waiting for user input.
 * Looks for common patterns in assistant text output.
 */
export function detectsQuestion(text: string): boolean {
  const questionPatterns = [
    /\bshould I\b/i,
    /\bwould you like\b/i,
    /\bdo you want\b/i,
    /\bcan you confirm\b/i,
    /\bplease confirm\b/i,
    /\blet me know\b/i,
    /\bwhat (?:do you|should|would)\b/i,
    /\bwhich (?:one|option|approach)\b/i,
    /\bproceed\?/i,
    /\bcontinue\?/i,
    /\bapprove\b.*\?/i,
  ];

  return questionPatterns.some((p) => p.test(text));
}

/**
 * Detects stub patterns in tool results (file writes/edits).
 * Used for early warning before completeness validation.
 */
export function detectsStubInOutput(text: string): boolean {
  // Use shared STUB_PATTERNS as single source of truth
  return STUB_PATTERNS.some((pattern) => text.includes(pattern));
}

/**
 * Extract token usage from a result message.
 */
export function parseResultMessage(msg: StreamMessage): ParsedResult | null {
  if (msg.type !== "result") return null;

  return {
    costUsd: (msg.cost_usd as number) ?? 0,
    durationMs: (msg.duration_ms as number) ?? 0,
    inputTokens: (msg.input_tokens as number) ?? 0,
    outputTokens: (msg.output_tokens as number) ?? 0,
    totalTokens: (msg.total_tokens as number) ?? 0,
    model: (msg.model as string) ?? "unknown",
    claudeSessionId: (msg.session_id as string) ?? null,
    numTurns: (msg.num_turns as number) ?? 0,
  };
}

/**
 * Count tool calls from a stream of messages for drift check interval tracking.
 */
export function extractToolName(msg: StreamMessage): string | null {
  if (msg.type === "tool_use" && msg.tool_name) {
    return msg.tool_name as string;
  }
  return null;
}
