import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

/**
 * Every headless `claude --print` call (validator, question responder, brain
 * extractors) writes a session transcript into `~/.claude/projects/<cwd-slug>/`.
 * When those calls inherit the server's cwd, they pollute the REAL project's
 * session list — tens of thousands of 20KB transcripts that make
 * `claude --resume` / `-c` / `/restore` hang while scanning the directory.
 *
 * All headless calls must instead run from this dedicated scratch cwd so
 * their transcripts land in a separate bucket that no human ever resumes.
 */
const HEADLESS_CWD = join(homedir(), ".nosleep", "headless");

let ensured = false;

export function headlessClaudeCwd(): string {
  if (!ensured) {
    mkdirSync(HEADLESS_CWD, { recursive: true });
    ensured = true;
  }
  return HEADLESS_CWD;
}

export interface HeadlessClaudeOptions {
  /** Hard wall-clock cap; the process is SIGKILL'd if it overruns. */
  readonly timeoutMs: number;
  /** Full environment for the child. CLAUDECODE is always stripped so the
   *  nested CLI runs in non-orchestrated mode. Defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
}

// ── Circuit breaker ─────────────────────────────────────────────────────────
// When the claude CLI is down/rate-limited/broken, EVERY headless call fails
// the same way; without a breaker the brain pipeline piled up 7,661 spawn→
// fail cycles (each burning a CLI boot + timeout wait). After N consecutive
// failures we fail fast for a cooldown instead of spawning at all.
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 10 * 60_000;

// One breaker per backend: "claude" (CLI + SDK share it, as before) and one
// per OpenAI-compatible endpoint ("openai:<baseUrl>") — a dead local Ollama
// must not fail-fast the validator's Claude calls, and vice versa.
const CLAUDE_BREAKER = "claude";
const breakers = new Map<string, { failures: number; openUntil: number }>();

function breakerRemainingMs(key: string): number {
  return (breakers.get(key)?.openUntil ?? 0) - Date.now();
}

function recordFailure(key: string = CLAUDE_BREAKER): void {
  const b = breakers.get(key) ?? { failures: 0, openUntil: 0 };
  b.failures += 1;
  if (b.failures >= BREAKER_THRESHOLD && b.openUntil <= Date.now()) {
    b.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    // eslint-disable-next-line no-console
    console.error(
      `[headless-claude] circuit OPEN for ${key} after ${b.failures} consecutive failures — failing fast for ${BREAKER_COOLDOWN_MS / 60000}m`,
    );
  }
  breakers.set(key, b);
}

function recordSuccess(key: string = CLAUDE_BREAKER): void {
  breakers.delete(key);
}

/** Test hook: reset breaker state between tests. */
export function __resetHeadlessCircuit(): void {
  breakers.clear();
}

// ── SDK-based one-shot query ────────────────────────────────────────────────

/** Fallback when the primary model is overloaded/unavailable (SDK-native). */
const DEFAULT_FALLBACK_MODEL = process.env.NOSLEEP_HEADLESS_FALLBACK_MODEL ?? "claude-sonnet-5";

export interface HeadlessQueryOptions {
  readonly prompt: string;
  readonly model: string;
  /** Defaults to NOSLEEP_HEADLESS_FALLBACK_MODEL (claude-sonnet-5). */
  readonly fallbackModel?: string;
  readonly timeoutMs: number;
  /** Tag the run NOSLEEP_BRAIN_INTERNAL=1 so nosleep hooks skip ingesting it
   *  (prevents the brain self-ingest recursion incident of 2026-05-18). */
  readonly brainInternal?: boolean;
  /** Which workload this is — selects the provider via NOSLEEP_LLM_* env
   *  (see resolveLlmRoute). Omitted → Claude, exactly as before. */
  readonly purpose?: LlmPurpose;
  /** Image inputs (vision purpose). Only the openai provider accepts them
   *  here; Claude vision stays on runClaudeHeadless (CLI --image). */
  readonly images?: readonly Buffer[];
}

// ── Provider routing (Claude subscription vs OpenAI-compatible endpoint) ────
// Background work (brain extractors, proposer, validator, question responder)
// spends the user's Claude subscription. Each workload ("purpose") can be
// routed to any OpenAI-compatible Chat Completions endpoint instead — local
// Ollama / LM Studio / llama.cpp / vLLM, or OpenRouter / OpenAI. Env:
//   NOSLEEP_LLM_PROVIDER=claude|openai   (default claude — unchanged behaviour)
//   NOSLEEP_LLM_BASE_URL  (default http://localhost:11434/v1, Ollama)
//   NOSLEEP_LLM_MODEL, NOSLEEP_LLM_API_KEY (optional), NOSLEEP_LLM_TIMEOUT_MS,
//   NOSLEEP_LLM_FALLBACK=claude|none (default none)
// Every key accepts a per-purpose override: <KEY>_BRAIN / _VALIDATOR /
// _RESPONDER / _VISION. Vision never inherits the text model: it routes to
// openai only with NOSLEEP_LLM_MODEL_VISION set, otherwise it is OFF (an
// explicit "skip") rather than silently spending Claude or feeding images to
// a text-only model. Pin it with NOSLEEP_LLM_PROVIDER_VISION=claude.

export type LlmPurpose = "brain" | "validator" | "responder" | "vision";
export const LLM_PURPOSES: readonly LlmPurpose[] = ["brain", "validator", "responder", "vision"];

export type LlmRoute =
  | { readonly provider: "claude" }
  | { readonly provider: "off"; readonly reason: string }
  | {
      readonly provider: "openai";
      readonly baseUrl: string;
      readonly model: string;
      readonly apiKey?: string;
      readonly fallback: "claude" | "none";
      readonly timeoutMs?: number;
    };

const DEFAULT_LLM_BASE_URL = "http://localhost:11434/v1";

const llmRouteSchema = z.object({
  NOSLEEP_LLM_PROVIDER: z.enum(["claude", "openai"]).default("claude"),
  NOSLEEP_LLM_BASE_URL: z.string().url().default(DEFAULT_LLM_BASE_URL),
  NOSLEEP_LLM_MODEL: z.string().min(1).optional(),
  NOSLEEP_LLM_API_KEY: z.string().min(1).optional(),
  NOSLEEP_LLM_FALLBACK: z.enum(["claude", "none"]).default("none"),
  NOSLEEP_LLM_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
});
type LlmRouteKey = keyof z.infer<typeof llmRouteSchema>;
const LLM_ROUTE_KEYS = Object.keys(llmRouteSchema.shape) as LlmRouteKey[];

/**
 * Resolve which backend serves `purpose`. Throws a clear config error (named
 * env vars, never their secret values) when the configuration is invalid.
 */
export function resolveLlmRoute(purpose: LlmPurpose, env: NodeJS.ProcessEnv = process.env): LlmRoute {
  const suffix = `_${purpose.toUpperCase()}`;
  const pick = (key: string): string | undefined => {
    const v = env[`${key}${suffix}`];
    if (v !== undefined && v !== "") return v;
    // Vision must not inherit a text model.
    if (purpose === "vision" && key === "NOSLEEP_LLM_MODEL") return undefined;
    const g = env[key];
    return g !== undefined && g !== "" ? g : undefined;
  };
  const raw = Object.fromEntries(LLM_ROUTE_KEYS.map((k) => [k, pick(k)]));
  const parsed = llmRouteSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${String(i.path[0])}${suffix} / ${String(i.path[0])}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid LLM config for purpose "${purpose}": ${issues}`);
  }
  const c = parsed.data;
  if (c.NOSLEEP_LLM_PROVIDER === "claude") return { provider: "claude" };
  if (!c.NOSLEEP_LLM_MODEL) {
    if (purpose === "vision") {
      return { provider: "off", reason: "provider openai but NOSLEEP_LLM_MODEL_VISION unset" };
    }
    throw new Error(
      `invalid LLM config for purpose "${purpose}": provider openai needs NOSLEEP_LLM_MODEL${suffix} or NOSLEEP_LLM_MODEL`,
    );
  }
  return {
    provider: "openai",
    baseUrl: c.NOSLEEP_LLM_BASE_URL.replace(/\/+$/, ""),
    model: c.NOSLEEP_LLM_MODEL,
    apiKey: c.NOSLEEP_LLM_API_KEY,
    fallback: c.NOSLEEP_LLM_FALLBACK,
    timeoutMs: c.NOSLEEP_LLM_TIMEOUT_MS,
  };
}

/** Validate every purpose's config (throws on invalid) and return one log
 *  line naming each purpose's backend. No secrets. Call at startup. */
export function describeLlmRouting(env: NodeJS.ProcessEnv = process.env): string {
  const parts = LLM_PURPOSES.map((p) => {
    const r = resolveLlmRoute(p, env);
    if (r.provider === "claude") return `${p}=claude`;
    if (r.provider === "off") return `${p}=off (${r.reason})`;
    const extras = [r.apiKey ? "key" : null, r.fallback === "claude" ? "fallback=claude" : null].filter(Boolean);
    return `${p}=openai(${r.model} @ ${r.baseUrl}${extras.length ? `, ${extras.join(", ")}` : ""})`;
  });
  return `llm routing: ${parts.join(" ")}`;
}

/** Remove reasoning-model chain-of-thought (<think>…</think>, <thinking>…)
 *  so callers' JSON extraction never latches onto braces inside it. */
function stripReasoning(text: string): string {
  let out = text.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "");
  // Some chat templates emit the opening tag in the prompt → only a closer.
  const close = /<\/(think|thinking|reasoning)>/gi;
  let lastEnd = -1;
  for (let m = close.exec(out); m; m = close.exec(out)) lastEnd = m.index + m[0].length;
  if (lastEnd !== -1) out = out.slice(lastEnd);
  // Truncated (unterminated) block → everything after it is reasoning.
  out = out.replace(/<(think|thinking|reasoning)>[\s\S]*$/i, "");
  return out.trim();
}

function imageMimeType(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  return "image/png";
}

type OpenAiRoute = Extract<LlmRoute, { provider: "openai" }>;

/** One-shot OpenAI-compatible Chat Completions call. Fails fast (connection
 *  refused rejects immediately), hard timeout via AbortSignal, own breaker. */
async function openAiChatQuery(route: OpenAiRoute, opts: HeadlessQueryOptions): Promise<string> {
  const key = `openai:${route.baseUrl}`;
  const remaining = breakerRemainingMs(key);
  if (remaining > 0) {
    throw new Error(`llm circuit open for ${route.baseUrl} (${Math.ceil(remaining / 1000)}s remaining) — recent calls all failed`);
  }
  const timeoutMs = route.timeoutMs ?? opts.timeoutMs;
  const content = opts.images?.length
    ? [
        { type: "text", text: opts.prompt },
        ...opts.images.map((img) => ({
          type: "image_url",
          image_url: { url: `data:${imageMimeType(img)};base64,${img.toString("base64")}` },
        })),
      ]
    : opts.prompt;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (route.apiKey) headers.authorization = `Bearer ${route.apiKey}`;

  try {
    const res = await fetch(`${route.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: route.model,
        messages: [{ role: "user", content }],
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const detail = (await res.text()).replace(/\s+/g, " ").slice(0, 300);
      throw new Error(`llm ${route.model} HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const raw = body.choices?.[0]?.message?.content;
    const text = typeof raw === "string"
      ? raw
      : Array.isArray(raw)
        ? raw.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("")
        : "";
    const cleaned = stripReasoning(text);
    if (!cleaned) throw new Error(`llm ${route.model} returned no content`);
    recordSuccess(key);
    return cleaned;
  } catch (err) {
    recordFailure(key);
    const e = err as Error;
    if (e?.name === "TimeoutError" || e?.name === "AbortError") {
      throw new Error(`llm query (${route.model} @ ${route.baseUrl}) timed out after ${timeoutMs}ms`);
    }
    if (e?.message?.startsWith("llm ")) throw e;
    const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
    throw new Error(`llm request to ${route.baseUrl} failed: ${cause?.code ?? cause?.message ?? e?.message ?? String(err)}`);
  }
}

/**
 * One-shot text generation for the background LLM call sites (validator,
 * question-responder, brain extractors/proposer). Routes by `purpose`:
 *  - claude (default): Agent SDK, unchanged behaviour.
 *  - openai: OpenAI-compatible endpoint; on failure optionally falls back to
 *    Claude (NOSLEEP_LLM_FALLBACK=claude), otherwise rejects so callers'
 *    existing null/skip handling applies.
 *  - off: rejects immediately (vision without a configured vision model).
 */
export async function headlessQuery(opts: HeadlessQueryOptions): Promise<string> {
  const route: LlmRoute = opts.purpose ? resolveLlmRoute(opts.purpose) : { provider: "claude" };
  if (route.provider === "off") {
    throw new Error(`llm purpose "${opts.purpose}" is disabled: ${route.reason}`);
  }
  if (route.provider === "openai") {
    try {
      return await openAiChatQuery(route, opts);
    } catch (err) {
      if (route.fallback !== "claude" || opts.images?.length) throw err;
      // eslint-disable-next-line no-console
      console.warn(`[headless-claude] ${opts.purpose} → openai failed (${(err as Error).message}); falling back to claude`);
    }
  }
  if (opts.images?.length) {
    throw new Error("image input is only supported on the openai provider — Claude vision uses runClaudeHeadless");
  }
  return claudeSdkQuery(opts);
}

/**
 * Claude path: one-shot text generation via the Agent SDK (query(),
 * maxTurns=1, no tools) — replaces per-call `claude --print` CLI spawns.
 * fallbackModel chain, abort-based timeout, structured result message.
 * Shares the "claude" circuit breaker with the CLI path.
 */
async function claudeSdkQuery(opts: HeadlessQueryOptions): Promise<string> {
  const remaining = breakerRemainingMs(CLAUDE_BREAKER);
  if (remaining > 0) {
    throw new Error(`headless claude circuit open (${Math.ceil(remaining / 1000)}s remaining) — recent calls all failed`);
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.CLAUDECODE;
    if (opts.brainInternal) env.NOSLEEP_BRAIN_INTERNAL = "1";

    const q = query({
      prompt: opts.prompt,
      options: {
        model: opts.model,
        fallbackModel: opts.fallbackModel ?? DEFAULT_FALLBACK_MODEL,
        maxTurns: 1,
        allowedTools: [],
        cwd: headlessClaudeCwd(),
        env: env as Record<string, string>,
        abortController: ac,
      },
    });

    for await (const msg of q) {
      if ((msg as { type?: string }).type === "result") {
        const r = msg as { subtype?: string; result?: string; is_error?: boolean };
        if (r.subtype === "success" && !r.is_error) {
          recordSuccess();
          return r.result ?? "";
        }
        recordFailure();
        // subtype "success" + is_error:true is how API-level failures
        // (credit exhausted, auth, overload) surface — include the result
        // text or thousands of these are undiagnosable in the logs.
        const detail = (r.result ?? "").replace(/\s+/g, " ").slice(0, 300);
        throw new Error(
          `headless query failed (${r.subtype ?? "unknown"}${r.is_error ? ", is_error" : ""})${detail ? `: ${detail}` : ""}`,
        );
      }
    }
    recordFailure();
    throw new Error("headless query ended without a result message");
  } catch (err) {
    if (ac.signal.aborted) {
      recordFailure();
      throw new Error(`headless query timed out after ${opts.timeoutMs}ms`);
    }
    // Result-path failures were already recorded (their messages start with
    // "headless query"); anything else is an SDK boot/spawn error — record it.
    if (!(err instanceof Error) || !err.message.startsWith("headless query")) {
      recordFailure();
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a headless `claude --print` invocation correctly. Centralizes three
 * things every call site needs and used to get wrong individually:
 *
 *  1. stdin = /dev/null. In --print mode the CLI waits 3s for stdin data
 *     before proceeding when stdin is an open pipe (the default for
 *     spawn/execFile). That 3s tax hit every brain/validator call —
 *     ~28k "no stdin data received in 3s" warnings in one log. Wiring
 *     stdin to "ignore" gives an immediate EOF, so the call starts at once.
 *  2. cwd = the scratch bucket, so transcripts never land in a real
 *     project's resume list (see headlessClaudeCwd).
 *  3. A real timeout that SIGKILLs, plus non-zero-exit rejection carrying
 *     the child's stderr so failures are diagnosable.
 */
export function runClaudeHeadless(
  args: readonly string[],
  opts: HeadlessClaudeOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const remaining = breakerRemainingMs(CLAUDE_BREAKER);
    if (remaining > 0) {
      reject(new Error(`headless claude circuit open (${Math.ceil(remaining / 1000)}s remaining) — recent calls all failed`));
      return;
    }

    const env = { ...(opts.env ?? process.env) };
    delete env.CLAUDECODE;

    const proc = spawn("claude", args as string[], {
      cwd: headlessClaudeCwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGKILL");
      recordFailure();
      reject(new Error(`claude headless timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      recordFailure();
      reject(err);
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        recordSuccess();
        resolve({ stdout, stderr });
      } else {
        recordFailure();
        reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
      }
    });
  });
}

/** Claude Code derives the project transcript dir by replacing every
 * non-alphanumeric char of the cwd path with `-`. */
function transcriptDirForCwd(cwd: string): string {
  return join(homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

/**
 * Delete headless scratch transcripts older than `maxAgeDays`.
 * Only ever touches the scratch bucket — never a real project's transcripts.
 * Returns the number of files removed.
 */
export function pruneHeadlessTranscripts(maxAgeDays = 3): number {
  const dir = transcriptDirForCwd(HEADLESS_CWD);
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let removed = 0;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0; // bucket doesn't exist yet — nothing to prune
  }

  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const filePath = join(dir, name);
    try {
      if (statSync(filePath).mtimeMs < cutoff) {
        unlinkSync(filePath);
        removed++;
      }
    } catch {
      // file vanished or unreadable — skip, never fail the prune
    }
  }
  return removed;
}
