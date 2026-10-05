import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Agent SDK: a controllable query() that yields scripted messages.
const queryMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

// spawn mock so runClaudeHeadless-path imports don't touch real processes.
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import { headlessQuery, __resetHeadlessCircuit } from "../../lib/headless-claude.js";

function scripted(messages: Array<Record<string, unknown>>) {
  return (async function* () {
    for (const m of messages) yield m;
  })();
}

describe("headlessQuery (Agent SDK path)", () => {
  beforeEach(() => {
    queryMock.mockReset();
    __resetHeadlessCircuit();
  });

  it("returns the result text on success and passes model/fallback/limits to the SDK", async () => {
    queryMock.mockReturnValue(scripted([
      { type: "system" },
      { type: "result", subtype: "success", is_error: false, result: "hello world" },
    ]));

    const out = await headlessQuery({ prompt: "hi", model: "claude-haiku-4-5", timeoutMs: 5000 });
    expect(out).toBe("hello world");

    const call = queryMock.mock.calls[0][0] as { prompt: string; options: Record<string, unknown> };
    expect(call.prompt).toBe("hi");
    expect(call.options.model).toBe("claude-haiku-4-5");
    expect(call.options.fallbackModel).toBe("claude-sonnet-5"); // default chain
    expect(call.options.maxTurns).toBe(1);
    expect(call.options.allowedTools).toEqual([]);
    expect(String(call.options.cwd)).toMatch(/\.nosleep[/\\]headless$/);
  });

  it("honors an explicit fallbackModel and brainInternal env tag", async () => {
    queryMock.mockReturnValue(scripted([
      { type: "result", subtype: "success", is_error: false, result: "ok" },
    ]));
    await headlessQuery({ prompt: "x", model: "m", fallbackModel: "fb", timeoutMs: 5000, brainInternal: true });
    const call = queryMock.mock.calls[0][0] as { options: { fallbackModel: string; env: Record<string, string> } };
    expect(call.options.fallbackModel).toBe("fb");
    expect(call.options.env.NOSLEEP_BRAIN_INTERNAL).toBe("1");
    expect(call.options.env.CLAUDECODE).toBeUndefined();
  });

  it("throws on an error result", async () => {
    queryMock.mockReturnValue(scripted([
      { type: "result", subtype: "error_during_execution", is_error: true },
    ]));
    await expect(headlessQuery({ prompt: "x", model: "m", timeoutMs: 5000 })).rejects.toThrow(/headless query failed/);
  });

  it("opens the shared circuit after 5 consecutive failures and fails fast", async () => {
    for (let i = 0; i < 5; i++) {
      queryMock.mockReturnValueOnce(scripted([
        { type: "result", subtype: "error_during_execution", is_error: true },
      ]));
      await expect(headlessQuery({ prompt: "x", model: "m", timeoutMs: 5000 })).rejects.toThrow();
    }
    expect(queryMock).toHaveBeenCalledTimes(5);
    // 6th: circuit open — no SDK call.
    await expect(headlessQuery({ prompt: "x", model: "m", timeoutMs: 5000 })).rejects.toThrow(/circuit open/);
    expect(queryMock).toHaveBeenCalledTimes(5);
  });

  it("times out via abort when the SDK never yields a result", async () => {
    queryMock.mockImplementation(({ options }: { options: { abortController: AbortController } }) =>
      (async function* () {
        yield { type: "system" };
        // Hang until aborted, then throw like the SDK would.
        await new Promise((_, rej) => {
          options.abortController.signal.addEventListener("abort", () => rej(new Error("aborted")));
        });
      })(),
    );
    await expect(headlessQuery({ prompt: "x", model: "m", timeoutMs: 100 })).rejects.toThrow(/timed out after 100ms/);
  });
});
