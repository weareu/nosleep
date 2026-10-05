import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { buildEnv, routeMessage, type StreamMessage } from "../../orchestrator/claude-cli.js";

/**
 * These guard the exact stream-json / env quirks documented in the project
 * memory: tokens live in a nested usage{} (and must include cache tokens),
 * cost in total_cost_usd, model in modelUsage{}, assistant text in
 * message.content[].text, and CLAUDECODE must be DELETED (not emptied) so a
 * nested Claude session can launch.
 */

describe("buildEnv", () => {
  const opts = { cwd: "/x", orgId: "org_personal", sessionId: "sess_1" };

  it("deletes CLAUDECODE so nested sessions can launch", () => {
    const prev = process.env.CLAUDECODE;
    process.env.CLAUDECODE = "1";
    try {
      const env = buildEnv(opts);
      expect("CLAUDECODE" in env).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = prev;
    }
  });

  it("passes org + session context to MCP servers", () => {
    const env = buildEnv(opts);
    expect(env.NOSLEEP_ORG_ID).toBe("org_personal");
    expect(env.NOSLEEP_SESSION_ID).toBe("sess_1");
  });
});

describe("routeMessage — result token aggregation", () => {
  function captureResult(msg: StreamMessage) {
    const ee = new EventEmitter();
    let result: Record<string, unknown> | undefined;
    ee.on("result", (r) => { result = r; });
    routeMessage(ee, msg);
    return result;
  }

  it("sums base + cache_read + cache_creation into inputTokens", () => {
    const r = captureResult({
      type: "result",
      total_cost_usd: 0.5,
      duration_ms: 1000,
      num_turns: 2,
      session_id: "cc_1",
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 500,
        output_tokens: 50,
      },
      modelUsage: { "claude-opus-4-8": { foo: 1 } },
    } as unknown as StreamMessage);

    expect(r).toBeDefined();
    expect(r!.inputTokens).toBe(1600); // 100 + 1000 + 500
    expect(r!.outputTokens).toBe(50);
    expect(r!.totalTokens).toBe(1650);
    expect(r!.cost).toBe(0.5); // from total_cost_usd, not a flat field
    expect(r!.model).toBe("claude-opus-4-8"); // first key of modelUsage
    expect(r!.sessionId).toBe("cc_1");
  });

  it("defaults cleanly when usage/modelUsage are absent", () => {
    const r = captureResult({ type: "result" } as unknown as StreamMessage);
    expect(r!.inputTokens).toBe(0);
    expect(r!.outputTokens).toBe(0);
    expect(r!.cost).toBe(0);
    expect(r!.model).toBe("unknown");
  });
});

describe("routeMessage — text + tool events", () => {
  it("extracts assistant text from message.content[].text blocks", () => {
    const ee = new EventEmitter();
    const texts: string[] = [];
    ee.on("text", (t) => texts.push(t));
    routeMessage(ee, {
      type: "assistant",
      message: { content: [
        { type: "text", text: "hello" },
        { type: "tool_use", text: "ignored-non-text-block" },
        { type: "text", text: "world" },
      ] },
    } as unknown as StreamMessage);
    expect(texts).toEqual(["hello", "world"]);
  });

  it("emits tool_use with name + input", () => {
    const ee = new EventEmitter();
    let tool: Record<string, unknown> | undefined;
    ee.on("tool_use", (t) => { tool = t; });
    routeMessage(ee, {
      type: "tool_use",
      tool_name: "Edit",
      tool_input: { file_path: "/a" },
    } as unknown as StreamMessage);
    expect(tool).toEqual({ name: "Edit", input: { file_path: "/a" } });
  });

  it("emits an Error for error messages", () => {
    const ee = new EventEmitter();
    let err: Error | undefined;
    ee.on("error", (e) => { err = e; });
    routeMessage(ee, { type: "error", content: "boom" } as unknown as StreamMessage);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe("boom");
  });
});
