// NoSleep plugin for OpenCode (sst/opencode, opencode.ai).
//
// Maps OpenCode plugin hooks/events onto the SAME NoSleep server endpoints the
// generated Claude Code hooks (.claude/nosleep-hooks/*.mjs) call, with the same
// payload shapes:
//
//   OpenCode                                 NoSleep endpoint (Claude hook equivalent)
//   ─────────────────────────────────────    ─────────────────────────────────────────
//   first hook for a session                 POST /api/sessions/register       (all hooks' _sid)
//   tool.execute.before                      POST /api/hooks/pre-tool          (PreToolUse)
//   tool.execute.after                       POST /api/hooks/post-tool         (PostToolUse)
//   chat.message (user text parts)           POST /api/brain/hook-ingest/user-prompt (UserPromptSubmit)
//   experimental.session.compacting          POST /api/hooks/pre-compact       (PreCompact)
//   event: session.idle                      drain / stop / decide-next / schedule-wake (Stop)
//
// Messages the server returns from pre-tool (goal reminders, budget warnings,
// coordination inbox) cannot be printed into the transcript the way a Claude
// hook's stdout is, so they are queued per session and appended to the system
// prompt of that session's NEXT model call (experimental.chat.system.transform).
// Steering messages drained on idle are sent as a new user turn via the
// OpenCode SDK client (the equivalent of the Claude Stop hook's
// `{decision:"block", reason}`).
//
// Fail-open by design: every network call has a short timeout and every hook
// swallows its own errors — NoSleep being down must never block or break
// OpenCode.
//
// Configuration (env wins over the installer-written .opencode/nosleep.json):
//   NOSLEEP_URL          server base URL        (default http://localhost:3777)
//   NOSLEEP_ORG_ID       org to register under  (default org_personal; the
//                        server re-attributes by project path anyway)
//   NOSLEEP_HOOK_SECRET  sent as x-hook-secret  (same as the Claude hooks)
//   NOSLEEP_SESSION_ID   pin an orchestrator-owned session id
//   NOSLEEP_BRAIN_INTERNAL=1  disables the plugin (headless brain calls)
//
// Only ONE export on purpose: OpenCode treats every exported function of a
// plugin file as a plugin, so a second export would double-report every event.
// Tests inject `fetch`, `env` and `configPath` through the input object
// (extra keys OpenCode never sets).

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const NoSleepPlugin = async (input = {}) => {
  const env = input.env ?? process.env;
  const fetchFn = input.fetch ?? globalThis.fetch;
  if (env.NOSLEEP_BRAIN_INTERNAL === "1" || typeof fetchFn !== "function") return {};

  // ── Config ────────────────────────────────────────────────
  const fileCfg = readConfig(input.configPath ?? defaultConfigPath());
  const baseUrl = String(env.NOSLEEP_URL || fileCfg.baseUrl || "http://localhost:3777").replace(/\/+$/, "");
  const orgId = env.NOSLEEP_ORG_ID || fileCfg.orgId || "org_personal";
  // OpenCode reports worktree "/" outside a git repo — never treat that as the project.
  const worktree = input.worktree && input.worktree !== "/" ? input.worktree : undefined;
  const projectPath = fileCfg.projectPath || worktree || input.directory || process.cwd();
  const cwd = input.directory || projectPath;
  // Headless one-shot runs (validator/brain) execute in ~/.nosleep/headless.
  if (/\/\.nosleep\/headless\/?$/.test(cwd)) return {};

  // Loop/connect/tool-count state lives in the SAME files the Claude hooks and
  // /nosleep-* commands use, so the commands work unchanged in both CLIs.
  const stateDir = join(projectPath, ".claude");
  const toolCountFile = join(stateDir, ".nosleep-tool-count");
  const loopActiveFile = join(stateDir, ".nosleep-loop-active");
  const connectedFile = join(stateDir, ".nosleep-connected");
  const lastTaskFile = join(stateDir, ".nosleep-last-task");

  const headers = { "Content-Type": "application/json" };
  if (env.NOSLEEP_HOOK_SECRET) headers["x-hook-secret"] = env.NOSLEEP_HOOK_SECRET;

  const client = input.client;
  const sessionIds = new Map(); // OpenCode sessionID → Promise<NoSleep session id | null>
  const pendingMessages = new Map(); // OpenCode sessionID → string[]

  async function post(path, body, timeoutMs = 4000) {
    try {
      const res = await fetchFn(baseUrl + path, {
        method: "POST",
        headers,
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res || !res.ok) return null;
      try { return await res.json(); } catch { return {}; }
    } catch {
      return null; // fail-open: server down / slow / bad JSON
    }
  }

  function resolveSession(ocSessionId) {
    if (env.NOSLEEP_SESSION_ID) return Promise.resolve(env.NOSLEEP_SESSION_ID);
    if (!ocSessionId) return Promise.resolve(null);
    const cached = sessionIds.get(ocSessionId);
    if (cached) return cached;
    const pending = post("/api/sessions/register", {
      orgId,
      projectPath,
      claudeSessionId: ocSessionId,
      cwd,
      agent: "opencode",
    }, 3000).then((r) => {
      const id = r?.data?.sessionId ?? null;
      if (!id) sessionIds.delete(ocSessionId); // retry on the next hook
      return id;
    });
    sessionIds.set(ocSessionId, pending);
    return pending;
  }

  function queueMessage(ocSessionId, message) {
    if (!message) return;
    const list = pendingMessages.get(ocSessionId) ?? [];
    list.push(message);
    pendingMessages.set(ocSessionId, list);
  }

  function takeMessages(ocSessionId) {
    const list = pendingMessages.get(ocSessionId);
    pendingMessages.delete(ocSessionId);
    return list ?? [];
  }

  async function onIdle(ocSessionId) {
    const sessionId = await resolveSession(ocSessionId);
    if (!sessionId) return;

    // Steering down-channel for a connected session (/nosleep-connect, /nosleep-go).
    if (existsSync(connectedFile)) {
      const dr = await post(`/api/sessions/${sessionId}/drain`, {});
      const steer = dr?.data?.message;
      if (steer && client?.session?.prompt) {
        try {
          await client.session.prompt({
            path: { id: ocSessionId },
            body: { parts: [{ type: "text", text: steer }] },
          });
        } catch { /* fail-open */ }
        return;
      }
    }

    if (!existsSync(loopActiveFile)) return;

    let toolCount = 0;
    try { toolCount = parseInt(readFileSync(toolCountFile, "utf-8").trim(), 10) || 0; } catch {}
    if (toolCount < 5) {
      tryUnlink(lastTaskFile);
      return;
    }

    await post("/api/hooks/stop", { orgId, sessionId, stopReason: "end_turn" }, 5000);
    const decision = await post(`/api/sessions/${sessionId}/decide-next`, { stopReason: "end_turn" }, 15000);
    const d = decision?.data;
    if (d && d.action && d.action !== "stop") {
      const delay = typeof d.delayMinutes === "number" && d.delayMinutes >= 1 ? Math.floor(d.delayMinutes) : 10;
      await post(`/api/sessions/${sessionId}/schedule-wake`, { delayMinutes: delay }, 5000);
    }
    tryUnlink(lastTaskFile);
  }

  return {
    "tool.execute.before": async (hook, output) => {
      try {
        const sessionId = await resolveSession(hook?.sessionID);
        const toolName = normalizeToolName(hook?.tool);
        const res = await post("/api/hooks/pre-tool", {
          orgId,
          sessionId,
          toolName,
          toolInput: normalizeToolInput(output?.args),
        });
        if (res?.message) queueMessage(hook?.sessionID, res.message);
      } catch { /* fail-open */ }
    },

    "tool.execute.after": async (hook, output) => {
      try {
        const sessionId = await resolveSession(hook?.sessionID);
        const toolName = normalizeToolName(hook?.tool);
        await post("/api/hooks/post-tool", {
          orgId,
          sessionId,
          toolName,
          toolInput: truncateObject(normalizeToolInput(hook?.args), 8192),
          toolResult: truncateString(output?.output, 65536),
        });
        if (REAL_TOOLS.has(toolName)) bumpToolCount(toolCountFile);
      } catch { /* fail-open */ }
    },

    "chat.message": async (hook, output) => {
      try {
        const prompt = (output?.parts ?? [])
          .filter((p) => p && p.type === "text" && !p.synthetic && typeof p.text === "string")
          .map((p) => p.text)
          .join("\n")
          .trim();
        if (!prompt) return;
        const sessionId = await resolveSession(hook?.sessionID);
        await post("/api/brain/hook-ingest/user-prompt", { orgId, sessionId, prompt });
      } catch { /* fail-open */ }
    },

    "experimental.chat.system.transform": async (hook, output) => {
      try {
        if (!hook?.sessionID || !Array.isArray(output?.system)) return;
        const messages = takeMessages(hook.sessionID);
        if (messages.length > 0) output.system.push(`[NoSleep]\n${messages.join("\n\n")}`);
      } catch { /* fail-open */ }
    },

    "experimental.session.compacting": async (hook, output) => {
      try {
        const sessionId = await resolveSession(hook?.sessionID);
        await post("/api/hooks/pre-compact", { orgId, sessionId });
        // Undelivered NoSleep messages must survive compaction.
        const messages = takeMessages(hook?.sessionID);
        if (messages.length > 0 && Array.isArray(output?.context)) {
          output.context.push(`## NoSleep (pending supervision messages)\n${messages.join("\n\n")}`);
        }
      } catch { /* fail-open */ }
    },

    event: async ({ event } = {}) => {
      try {
        if (event?.type === "session.idle") await onIdle(event.properties?.sessionID);
        else if (event?.type === "session.deleted") {
          const id = event.properties?.info?.id;
          if (id) { sessionIds.delete(id); pendingMessages.delete(id); }
        }
      } catch { /* fail-open */ }
    },
  };
};

// ── Helpers (module-private) ────────────────────────────────

/** OpenCode built-in tool ids → the Claude Code names the server keys off
 *  (file-lock check on Edit/Write, real-tool counting for the loop). MCP and
 *  custom tools pass through unchanged. */
const TOOL_NAME_MAP = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  multiedit: "Edit",
  patch: "Edit",
  apply_patch: "Edit",
  glob: "Glob",
  grep: "Grep",
  list: "LS",
  task: "Agent",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  todowrite: "TodoWrite",
  todoread: "TodoRead",
  skill: "Skill",
};

const REAL_TOOLS = new Set(["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent"]);

function normalizeToolName(tool) {
  if (typeof tool !== "string" || !tool) return undefined;
  return TOOL_NAME_MAP[tool] ?? tool;
}

/** OpenCode args use camelCase (filePath); the server reads Claude's file_path. */
function normalizeToolInput(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const out = { ...args };
  if (typeof args.filePath === "string" && out.file_path === undefined) out.file_path = args.filePath;
  return out;
}

function truncateObject(value, max) {
  if (!value) return value;
  try {
    const s = JSON.stringify(value);
    if (s.length <= max) return value;
    return { _truncated: true, original_size: s.length, sample: s.slice(0, 2048) };
  } catch {
    return undefined;
  }
}

/** The post-tool route validates toolResult as a string, so truncation keeps it one. */
function truncateString(value, max) {
  if (value === undefined || value === null) return undefined;
  const s = typeof value === "string" ? value : safeStringify(value);
  if (s === undefined || s.length <= max) return s;
  return `${s.slice(0, max)}\n[nosleep: truncated, original_size=${s.length}]`;
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return undefined; }
}

function bumpToolCount(file) {
  let count = 0;
  try { count = parseInt(readFileSync(file, "utf-8").trim(), 10) || 0; } catch {}
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, String(count + 1));
  } catch {}
}

function tryUnlink(file) {
  try { if (existsSync(file)) unlinkSync(file); } catch {}
}

function defaultConfigPath() {
  try {
    // Installed at <project>/.opencode/plugins/nosleep.js → <project>/.opencode/nosleep.json
    return join(dirname(fileURLToPath(import.meta.url)), "..", "nosleep.json");
  } catch {
    return undefined;
  }
}

function readConfig(path) {
  if (!path) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
