import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

/** Resolve the absolute path to the `claude` CLI binary */
function resolveClaudeBinary(): string {
  const candidates = [
    `${process.env.HOME}/.local/bin/claude`,
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  try {
    return execFileSync("which", ["claude"], { encoding: "utf-8" }).trim();
  } catch {
    return "claude";
  }
}

const CLAUDE_BIN = resolveClaudeBinary();

export interface ClaudeCliOptions {
  /** Working directory for the Claude session */
  readonly cwd: string;
  /** Organization ID for MCP scoping */
  readonly orgId: string;
  /** NoSleep session ID (passed to MCP servers via env) */
  readonly sessionId: string;
  /** Model override (e.g., "sonnet", "opus") */
  readonly model?: string;
  /** Max budget in USD (safety cap) */
  readonly maxBudgetUsd?: number;
  /** Additional allowed tools */
  readonly allowedTools?: readonly string[];
  /** System prompt to append */
  readonly appendSystemPrompt?: string;
  /** Permission mode */
  readonly permissionMode?: "default" | "plan" | "auto" | "acceptEdits" | "supervised";
  /** Additional MCP config file paths */
  readonly mcpConfig?: readonly string[];
  /** Additional directories to allow access to */
  readonly addDirs?: readonly string[];
}

export interface StreamMessage {
  readonly type: string;
  readonly subtype?: string;
  readonly content?: string;
  readonly tool_name?: string;
  readonly tool_input?: Record<string, unknown>;
  readonly tool_result?: string;
  readonly session_id?: string;
  readonly cost_usd?: number;
  readonly duration_ms?: number;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_tokens?: number;
  readonly model?: string;
  readonly num_turns?: number;
  readonly [key: string]: unknown;
}

export interface ClaudeProcess {
  readonly pid: number;
  readonly process: ChildProcess;
  readonly events: EventEmitter;
  kill(): void;
  sendInput(text: string): boolean;
}

/**
 * Wire stdout/stderr parsing, exit flushing, error handling, and kill/sendInput
 * onto a spawned ChildProcess. Returns a ClaudeProcess facade.
 */
function wireProcess(proc: ChildProcess): ClaudeProcess {
  const events = new EventEmitter();
  const stdoutBuf = { value: "" };
  const stderrBuf = { value: "" };

  function parseStreamChunk(chunk: Buffer, bufferRef: { value: string }): void {
    bufferRef.value += chunk.toString();
    const lines = bufferRef.value.split("\n");
    bufferRef.value = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as StreamMessage;
        events.emit("message", msg);
        routeMessage(events, msg);
      } catch {
        events.emit("raw", trimmed);
      }
    }
  }

  function flushBuffer(buf: { value: string }): void {
    if (!buf.value.trim()) return;
    try {
      const msg = JSON.parse(buf.value.trim()) as StreamMessage;
      events.emit("message", msg);
      routeMessage(events, msg);
    } catch {
      events.emit("raw", buf.value.trim());
    }
  }

  // Claude CLI v2.1.72+ sends stream-json on stderr with --verbose.
  // Parse both streams for forward compatibility.
  proc.stdout?.on("data", (chunk: Buffer) => parseStreamChunk(chunk, stdoutBuf));
  proc.stderr?.on("data", (chunk: Buffer) => parseStreamChunk(chunk, stderrBuf));

  proc.on("exit", (code, signal) => {
    flushBuffer(stdoutBuf);
    flushBuffer(stderrBuf);
    events.emit("exit", { code, signal });
  });

  proc.on("error", (err) => {
    events.emit("error", err);
  });

  const pid = proc.pid ?? -1;
  let killTimer: ReturnType<typeof setTimeout> | null = null;

  // Clear the kill timer when the process exits to prevent memory leak
  proc.on("exit", () => {
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
  });

  return {
    pid,
    process: proc,
    events,
    kill() {
      if (!proc.killed) {
        proc.kill("SIGTERM");
        // Force kill after 5 seconds if still running
        killTimer = setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
          killTimer = null;
        }, 5000);
      }
    },
    sendInput(text: string): boolean {
      if (proc.stdin?.writable) {
        proc.stdin.write(text + "\n");
        return true;
      }
      return false;
    },
  };
}

/**
 * Wraps the `claude` CLI for programmatic session management.
 *
 * Uses `--print --output-format stream-json` for structured output parsing.
 * Each spawned process is a fully autonomous Claude Code session.
 */
export function spawnClaudeSession(
  prompt: string,
  options: ClaudeCliOptions,
): ClaudeProcess {
  const args = buildArgs(prompt, options);
  const env = buildEnv(options);

  // Claude CLI blocks on open stdin pipe in --print mode.
  // Use pipe + immediately end so output flows.
  const proc = spawn(CLAUDE_BIN, args, {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // End stdin immediately — prompt is in args, and --print mode doesn't read stdin interactively.
  // This unblocks the Claude binary which otherwise waits on an open stdin pipe.
  proc.stdin?.end();

  return wireProcess(proc);
}

/**
 * Resume an existing Claude Code session.
 */
export function resumeClaudeSession(
  claudeSessionId: string,
  options: ClaudeCliOptions,
): ClaudeProcess {
  const args = [
    "--resume", claudeSessionId,
    "--print",
    "--verbose",
    "--output-format", "stream-json",
  ];

  if (options.permissionMode) {
    args.push("--permission-mode", options.permissionMode);
  }

  const env = buildEnv(options);

  const proc = spawn(CLAUDE_BIN, args, {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Keep stdin open for resumed sessions — the new goal prompt will be sent
  // via sendInput() after a short delay (see session-manager.ts resumeTimer).
  // Unlike fresh spawns, resumed sessions need stdin to receive the follow-up prompt.

  return wireProcess(proc);
}

/**
 * Generate a deterministic goal hash for drift detection.
 */
export function hashGoal(goal: string): string {
  return createHash("sha256").update(goal).digest("hex").slice(0, 16);
}

// ── Internal helpers ────────────────────────────────────

function buildArgs(prompt: string, options: ClaudeCliOptions): string[] {
  const args = [
    "--print",
    "--verbose",
    "--output-format", "stream-json",
  ];

  if (options.model) {
    args.push("--model", options.model);
  }

  if (options.maxBudgetUsd) {
    args.push("--max-budget-usd", options.maxBudgetUsd.toString());
  }

  if (options.permissionMode) {
    args.push("--permission-mode", options.permissionMode);
  }

  if (options.allowedTools && options.allowedTools.length > 0) {
    args.push("--allowedTools", ...options.allowedTools);
  }

  if (options.appendSystemPrompt) {
    args.push("--append-system-prompt", options.appendSystemPrompt);
  }

  if (options.mcpConfig) {
    for (const config of options.mcpConfig) {
      args.push("--mcp-config", config);
    }
  }

  if (options.addDirs) {
    args.push("--add-dir", ...options.addDirs);
  }

  // The prompt goes last
  args.push(prompt);

  return args;
}

export function buildEnv(options: ClaudeCliOptions): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Remove CLAUDECODE to allow nested sessions (Claude Code blocks launch if this exists)
  delete env.CLAUDECODE;
  // Pass org and session context to MCP servers
  env.NOSLEEP_ORG_ID = options.orgId;
  env.NOSLEEP_SESSION_ID = options.sessionId;
  return env;
}

export function routeMessage(events: EventEmitter, msg: StreamMessage): void {
  switch (msg.type) {
    case "assistant": {
      // Stream-json assistant format: { message: { content: [{ type: "text", text: "..." }] } }
      const message = msg.message as Record<string, unknown> | undefined;
      const contentBlocks = message?.content as Array<{ type: string; text?: string }> | undefined;
      if (contentBlocks) {
        for (const block of contentBlocks) {
          if (block.type === "text" && block.text) {
            events.emit("text", block.text);
          }
        }
      }
      // Fallback for simple format
      if (msg.subtype === "text" && typeof msg.content === "string") {
        events.emit("text", msg.content);
      }
      break;
    }
    case "tool_use":
      events.emit("tool_use", {
        name: msg.tool_name,
        input: msg.tool_input,
      });
      break;
    case "tool_result":
      events.emit("tool_result", {
        name: msg.tool_name,
        result: msg.tool_result,
      });
      break;
    case "result": {
      // Stream-json result format: tokens in usage{} and modelUsage{}, cost in total_cost_usd
      const usage = msg.usage as Record<string, unknown> | undefined;
      const modelUsage = msg.modelUsage as Record<string, Record<string, unknown>> | undefined;
      const firstModel = modelUsage ? Object.keys(modelUsage)[0] : undefined;

      const inputTokens = (usage?.input_tokens as number ?? 0)
        + (usage?.cache_read_input_tokens as number ?? 0)
        + (usage?.cache_creation_input_tokens as number ?? 0);
      const outputTokens = usage?.output_tokens as number ?? 0;

      events.emit("result", {
        cost: msg.total_cost_usd as number ?? 0,
        duration: msg.duration_ms as number ?? 0,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        model: firstModel ?? "unknown",
        sessionId: msg.session_id as string ?? null,
        numTurns: msg.num_turns as number ?? 0,
      });
      break;
    }
    case "error":
      events.emit("error", new Error(msg.content ?? "Unknown CLI error"));
      break;
  }
}
