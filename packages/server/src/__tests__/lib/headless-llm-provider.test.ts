import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

// The Claude path goes through the Agent SDK; mock it so we can assert
// whether a call was routed to Claude without spawning anything.
const queryMock = vi.fn();
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

import {
  headlessQuery,
  resolveLlmRoute,
  describeLlmRouting,
  __resetHeadlessCircuit,
} from "../../lib/headless-claude.js";
import { createClaudeVisionProviders } from "../../brain/extractors/claude-vision-provider.js";

// ── Fake OpenAI-compatible server (node:http, no network) ───────────────────

interface Captured {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

type Responder = (req: Captured, res: http.ServerResponse) => void;

let server: http.Server;
let baseUrl: string;
let captured: Captured[] = [];
let responder: Responder;

function reply(content: string, usage?: Record<string, number>): Responder {
  return (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "x",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const cap: Captured = {
        url: req.url ?? "",
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      };
      captured.push(cap);
      responder(cap, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const LLM_ENV_KEYS = () => Object.keys(process.env).filter((k) => k.startsWith("NOSLEEP_LLM_"));

function setEnv(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}

beforeEach(() => {
  captured = [];
  responder = reply("ok");
  queryMock.mockReset();
  queryMock.mockReturnValue((async function* () {
    yield { type: "result", subtype: "success", is_error: false, result: "from-claude" };
  })());
  __resetHeadlessCircuit();
  for (const k of LLM_ENV_KEYS()) delete process.env[k];
});

afterEach(() => {
  for (const k of LLM_ENV_KEYS()) delete process.env[k];
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("headlessQuery provider routing", () => {
  it("default (no NOSLEEP_LLM_* env) stays on Claude for every purpose", async () => {
    for (const purpose of ["brain", "validator", "responder"] as const) {
      expect(resolveLlmRoute(purpose).provider).toBe("claude");
    }
    expect(resolveLlmRoute("vision").provider).toBe("claude");
    const out = await headlessQuery({ prompt: "p", model: "claude-haiku-4-5", timeoutMs: 5000, purpose: "brain" });
    expect(out).toBe("from-claude");
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(0);
  });

  it("sends an OpenAI Chat Completions request with the configured model and no Authorization when no key", async () => {
    setEnv({ NOSLEEP_LLM_PROVIDER: "openai", NOSLEEP_LLM_BASE_URL: baseUrl, NOSLEEP_LLM_MODEL: "qwen2.5:7b" });
    responder = reply('{"keep": false}');

    const out = await headlessQuery({ prompt: "classify this", model: "claude-haiku-4-5", timeoutMs: 5000, purpose: "brain" });

    expect(out).toBe('{"keep": false}');
    expect(queryMock).not.toHaveBeenCalled();
    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req.url).toBe("/v1/chat/completions");
    expect(req.body.model).toBe("qwen2.5:7b");
    expect(req.body.messages).toEqual([{ role: "user", content: "classify this" }]);
    expect(req.body.stream).toBe(false);
    expect(req.headers.authorization).toBeUndefined();
  });

  it("sends a Bearer Authorization header only when an API key is set", async () => {
    setEnv({
      NOSLEEP_LLM_PROVIDER: "openai",
      NOSLEEP_LLM_BASE_URL: `${baseUrl}/`, // trailing slash tolerated
      NOSLEEP_LLM_MODEL: "openai/gpt-5-mini",
      NOSLEEP_LLM_API_KEY: "sk-test-123",
    });
    await headlessQuery({ prompt: "x", model: "m", timeoutMs: 5000, purpose: "validator" });
    expect(captured[0].url).toBe("/v1/chat/completions");
    expect(captured[0].headers.authorization).toBe("Bearer sk-test-123");
  });

  it("routes per purpose: brain → openai while validator and responder stay on Claude", async () => {
    setEnv({
      NOSLEEP_LLM_PROVIDER_BRAIN: "openai",
      NOSLEEP_LLM_BASE_URL_BRAIN: baseUrl,
      NOSLEEP_LLM_MODEL_BRAIN: "llama3.2:3b",
    });
    responder = reply("brain-local");

    expect(await headlessQuery({ prompt: "a", model: "m", timeoutMs: 5000, purpose: "brain" })).toBe("brain-local");
    expect(await headlessQuery({ prompt: "b", model: "m", timeoutMs: 5000, purpose: "validator" })).toBe("from-claude");
    expect(captured).toHaveLength(1);
    expect(captured[0].body.model).toBe("llama3.2:3b");
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("per-purpose override beats the global setting (global openai, validator pinned to claude)", async () => {
    setEnv({
      NOSLEEP_LLM_PROVIDER: "openai",
      NOSLEEP_LLM_BASE_URL: baseUrl,
      NOSLEEP_LLM_MODEL: "global-model",
      NOSLEEP_LLM_PROVIDER_VALIDATOR: "claude",
      NOSLEEP_LLM_MODEL_RESPONDER: "responder-model",
    });
    expect(resolveLlmRoute("validator").provider).toBe("claude");
    await headlessQuery({ prompt: "r", model: "m", timeoutMs: 5000, purpose: "responder" });
    expect(captured[0].body.model).toBe("responder-model");
  });

  it("strips <think> reasoning blocks before returning text", async () => {
    setEnv({ NOSLEEP_LLM_PROVIDER: "openai", NOSLEEP_LLM_BASE_URL: baseUrl, NOSLEEP_LLM_MODEL: "qwen3:8b" });
    responder = reply('<think>\nThe user wants {json}. Let me think {"a":1}...\n</think>\n\n```json\n{"keep": true, "type": "decision"}\n```');
    const out = await headlessQuery({ prompt: "x", model: "m", timeoutMs: 5000, purpose: "brain" });
    expect(out).not.toMatch(/think/i);
    expect(out).toBe('```json\n{"keep": true, "type": "decision"}\n```');
  });

  it("strips a dangling </think> prefix (template put the opening tag in the prompt)", async () => {
    setEnv({ NOSLEEP_LLM_PROVIDER: "openai", NOSLEEP_LLM_BASE_URL: baseUrl, NOSLEEP_LLM_MODEL: "deepseek-r1:7b" });
    responder = reply('reasoning {not json} here</think>{"action":"continue"}');
    expect(await headlessQuery({ prompt: "x", model: "m", timeoutMs: 5000, purpose: "responder" })).toBe('{"action":"continue"}');
  });

  it("times out (rejects) instead of hanging when the server never answers", async () => {
    setEnv({ NOSLEEP_LLM_PROVIDER: "openai", NOSLEEP_LLM_BASE_URL: baseUrl, NOSLEEP_LLM_MODEL: "slow" });
    responder = () => { /* never respond */ };
    const started = Date.now();
    await expect(headlessQuery({ prompt: "x", model: "m", timeoutMs: 200, purpose: "brain" })).rejects.toThrow(/timed out after 200ms/);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("NOSLEEP_LLM_TIMEOUT_MS overrides the caller's timeout for the openai route", async () => {
    setEnv({ NOSLEEP_LLM_PROVIDER: "openai", NOSLEEP_LLM_BASE_URL: baseUrl, NOSLEEP_LLM_MODEL: "slow", NOSLEEP_LLM_TIMEOUT_MS: "150" });
    responder = () => { /* never respond */ };
    await expect(headlessQuery({ prompt: "x", model: "m", timeoutMs: 60_000, purpose: "brain" })).rejects.toThrow(/timed out after 150ms/);
  });

  it("fails fast when the local server is down (connection refused)", async () => {
    setEnv({ NOSLEEP_LLM_PROVIDER: "openai", NOSLEEP_LLM_BASE_URL: "http://127.0.0.1:1/v1", NOSLEEP_LLM_MODEL: "m" });
    const started = Date.now();
    await expect(headlessQuery({ prompt: "x", model: "m", timeoutMs: 30_000, purpose: "brain" })).rejects.toThrow(/llm request to http:\/\/127\.0\.0\.1:1\/v1 failed/);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("rejects on a non-2xx response with the status, never leaking the API key", async () => {
    setEnv({ NOSLEEP_LLM_PROVIDER: "openai", NOSLEEP_LLM_BASE_URL: baseUrl, NOSLEEP_LLM_MODEL: "nope", NOSLEEP_LLM_API_KEY: "sk-secret-zzz" });
    responder = (_r, res) => { res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"model not found"}'); };
    const err = await headlessQuery({ prompt: "x", model: "m", timeoutMs: 5000, purpose: "brain" }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/HTTP 404.*model not found/);
    expect((err as Error).message).not.toContain("sk-secret-zzz");
  });

  it("falls back to Claude only when NOSLEEP_LLM_FALLBACK=claude", async () => {
    setEnv({ NOSLEEP_LLM_PROVIDER: "openai", NOSLEEP_LLM_BASE_URL: "http://127.0.0.1:1/v1", NOSLEEP_LLM_MODEL: "m" });
    await expect(headlessQuery({ prompt: "x", model: "claude-haiku-4-5", timeoutMs: 5000, purpose: "brain" })).rejects.toThrow();
    expect(queryMock).not.toHaveBeenCalled();

    process.env.NOSLEEP_LLM_FALLBACK = "claude";
    const out = await headlessQuery({ prompt: "x", model: "claude-haiku-4-5", timeoutMs: 5000, purpose: "brain" });
    expect(out).toBe("from-claude");
    const call = queryMock.mock.calls[0][0] as { options: { model: string } };
    expect(call.options.model).toBe("claude-haiku-4-5");
  });

  it("opens a per-endpoint circuit after 5 consecutive failures without tripping the Claude circuit", async () => {
    setEnv({ NOSLEEP_LLM_PROVIDER_BRAIN: "openai", NOSLEEP_LLM_BASE_URL_BRAIN: baseUrl, NOSLEEP_LLM_MODEL_BRAIN: "m" });
    responder = (_r, res) => { res.writeHead(500); res.end("boom"); };
    for (let i = 0; i < 5; i++) {
      await expect(headlessQuery({ prompt: "x", model: "m", timeoutMs: 5000, purpose: "brain" })).rejects.toThrow(/HTTP 500/);
    }
    expect(captured).toHaveLength(5);
    await expect(headlessQuery({ prompt: "x", model: "m", timeoutMs: 5000, purpose: "brain" })).rejects.toThrow(/circuit open/);
    expect(captured).toHaveLength(5); // failed fast, no request

    // Validator (Claude) unaffected.
    expect(await headlessQuery({ prompt: "v", model: "m", timeoutMs: 5000, purpose: "validator" })).toBe("from-claude");
  });

  it("sends images as data-URL content parts on the vision route", async () => {
    setEnv({
      NOSLEEP_LLM_PROVIDER_VISION: "openai",
      NOSLEEP_LLM_BASE_URL_VISION: baseUrl,
      NOSLEEP_LLM_MODEL_VISION: "qwen2.5vl:3b",
    });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    await headlessQuery({ prompt: "describe", model: "m", timeoutMs: 5000, purpose: "vision", images: [png] });
    const msg = (captured[0].body.messages as Array<{ content: unknown }>)[0];
    expect(captured[0].body.model).toBe("qwen2.5vl:3b");
    expect(msg.content).toEqual([
      { type: "text", text: "describe" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } },
    ]);
  });
});

describe("LLM route config", () => {
  it("vision is disabled (not silently sent to a text model) when openai is selected without NOSLEEP_LLM_MODEL_VISION", () => {
    setEnv({ NOSLEEP_LLM_PROVIDER: "openai", NOSLEEP_LLM_BASE_URL: baseUrl, NOSLEEP_LLM_MODEL: "text-only" });
    const r = resolveLlmRoute("vision");
    expect(r.provider).toBe("off");
  });

  it("vision can be pinned to Claude explicitly while the rest goes local", () => {
    setEnv({ NOSLEEP_LLM_PROVIDER: "openai", NOSLEEP_LLM_MODEL: "text", NOSLEEP_LLM_PROVIDER_VISION: "claude" });
    expect(resolveLlmRoute("vision").provider).toBe("claude");
  });

  it("defaults the base URL to local Ollama", () => {
    setEnv({ NOSLEEP_LLM_PROVIDER: "openai", NOSLEEP_LLM_MODEL: "m" });
    const r = resolveLlmRoute("brain");
    expect(r).toMatchObject({ provider: "openai", baseUrl: "http://localhost:11434/v1", model: "m" });
  });

  it("rejects invalid config with a clear message (openai without a model, bad provider, bad URL)", () => {
    setEnv({ NOSLEEP_LLM_PROVIDER: "openai" });
    expect(() => resolveLlmRoute("brain")).toThrow(/NOSLEEP_LLM_MODEL_BRAIN or NOSLEEP_LLM_MODEL/);
    setEnv({ NOSLEEP_LLM_PROVIDER: "gemini", NOSLEEP_LLM_MODEL: "m" });
    expect(() => resolveLlmRoute("brain")).toThrow(/NOSLEEP_LLM_PROVIDER/);
    setEnv({ NOSLEEP_LLM_PROVIDER: "openai", NOSLEEP_LLM_BASE_URL: "not a url" });
    expect(() => resolveLlmRoute("brain")).toThrow(/NOSLEEP_LLM_BASE_URL/);
  });

  it("describeLlmRouting names each purpose's provider/model and never prints the API key", () => {
    setEnv({
      NOSLEEP_LLM_PROVIDER_BRAIN: "openai",
      NOSLEEP_LLM_MODEL_BRAIN: "qwen2.5:7b",
      NOSLEEP_LLM_API_KEY: "sk-must-not-print",
    });
    const line = describeLlmRouting();
    expect(line).toContain("brain=openai(qwen2.5:7b @ http://localhost:11434/v1, key)");
    expect(line).toContain("validator=claude");
    expect(line).toContain("responder=claude");
    expect(line).toContain("vision=claude");
    expect(line).not.toContain("sk-must-not-print");
  });
});

describe("vision providers honour the route", () => {
  it("openai vision model: caption/ocr/scene come from the OpenAI-compatible endpoint in one request", async () => {
    setEnv({ NOSLEEP_LLM_PROVIDER: "openai", NOSLEEP_LLM_BASE_URL: baseUrl, NOSLEEP_LLM_MODEL: "text", NOSLEEP_LLM_MODEL_VISION: "llava:7b" });
    responder = reply('<think>look at it</think>```json\n{"ocr_text":"HELLO","caption":"A terminal","scene_class":"terminal"}\n```');
    const v = createClaudeVisionProviders();
    const img = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 7, 7, 1]);
    expect(await v.caption.caption(img)).toBe("A terminal");
    expect(await v.ocr.recognise(img)).toBe("HELLO");
    expect(await v.scene.classify(img)).toBe("terminal");
    expect(captured).toHaveLength(1);
    expect(captured[0].body.model).toBe("llava:7b");
  });

  it("openai without a vision model: vision is skipped (null) — no request, no Claude spawn", async () => {
    setEnv({ NOSLEEP_LLM_PROVIDER: "openai", NOSLEEP_LLM_BASE_URL: baseUrl, NOSLEEP_LLM_MODEL: "text" });
    const v = createClaudeVisionProviders();
    expect(await v.caption.caption(Buffer.from([1, 2, 3, 4, 5, 6]))).toBeNull();
    expect(captured).toHaveLength(0);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
