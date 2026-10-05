import { describe, it, expect } from "vitest";
import {
  detectsQuestion,
  detectsStubInOutput,
  parseResultMessage,
  extractToolName,
} from "../../orchestrator/output-parser.js";
import { STUB_PATTERNS } from "@nosleep/shared";
import type { StreamMessage } from "../../orchestrator/claude-cli.js";

describe("detectsQuestion", () => {
  it("flags assistant turns that ask the user to decide", () => {
    expect(detectsQuestion("Should I proceed with the migration?")).toBe(true);
    expect(detectsQuestion("Would you like me to refactor this?")).toBe(true);
    expect(detectsQuestion("Let me know how to handle it.")).toBe(true);
    expect(detectsQuestion("Which approach do you prefer?")).toBe(true);
  });

  it("does not flag plain progress statements", () => {
    expect(detectsQuestion("I refactored the parser and all tests pass.")).toBe(false);
    expect(detectsQuestion("Done. Committed and pushed.")).toBe(false);
  });
});

describe("detectsStubInOutput", () => {
  it("flags output containing a shared stub pattern", () => {
    // Build the positive case from the SHARED source of truth, so the test
    // tracks the real pattern set rather than a hardcoded copy.
    const sample = `function foo() {\n  ${STUB_PATTERNS[0]}\n}`;
    expect(detectsStubInOutput(sample)).toBe(true);
  });

  it("does not flag real implementation text", () => {
    expect(detectsStubInOutput("return a + b;")).toBe(false);
  });
});

describe("parseResultMessage", () => {
  it("extracts usage fields from a result message", () => {
    const msg = {
      type: "result",
      cost_usd: 0.42,
      duration_ms: 1234,
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      model: "claude-haiku-4-5",
      session_id: "cc_abc",
      num_turns: 3,
    } as unknown as StreamMessage;

    expect(parseResultMessage(msg)).toEqual({
      costUsd: 0.42,
      durationMs: 1234,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      model: "claude-haiku-4-5",
      claudeSessionId: "cc_abc",
      numTurns: 3,
    });
  });

  it("returns null for non-result messages", () => {
    expect(parseResultMessage({ type: "assistant" } as unknown as StreamMessage)).toBeNull();
  });

  it("defaults missing fields rather than throwing", () => {
    const parsed = parseResultMessage({ type: "result" } as unknown as StreamMessage);
    expect(parsed).toEqual({
      costUsd: 0,
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      model: "unknown",
      claudeSessionId: null,
      numTurns: 0,
    });
  });
});

describe("extractToolName", () => {
  it("returns the tool name for a tool_use message", () => {
    expect(extractToolName({ type: "tool_use", tool_name: "Edit" } as unknown as StreamMessage)).toBe("Edit");
  });

  it("returns null for non-tool messages", () => {
    expect(extractToolName({ type: "assistant" } as unknown as StreamMessage)).toBeNull();
    expect(extractToolName({ type: "tool_use" } as unknown as StreamMessage)).toBeNull();
  });
});
