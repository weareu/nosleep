import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectOpenCode,
  installOpenCodeHooks,
  uninstallOpenCodeHooks,
} from "./hooks-installer-opencode.js";

/** Coding-agent CLIs the installer can wire into NoSleep. */
export type HookTarget = "claude" | "opencode";

interface HooksConfig {
  /** Port the NoSleep server listens on */
  readonly serverPort: number;
  /** Organization ID */
  readonly orgId: string;
  /**
   * Which CLIs to install for. Omitted → Claude Code always, plus OpenCode
   * when the project already has OpenCode config (.opencode/, opencode.json[c]).
   */
  readonly targets?: readonly HookTarget[];
}

/** Resolve the effective install targets for a project. */
export function resolveHookTargets(projectPath: string, targets?: readonly HookTarget[]): HookTarget[] {
  if (targets && targets.length > 0) return [...new Set(targets)];
  return detectOpenCode(projectPath) ? ["claude", "opencode"] : ["claude"];
}

/**
 * Claude Code hook format (current):
 * { matcher: string, hooks: [{ type, command, timeout }] }
 *
 * matcher: tool name ("Bash"), pipe-separated ("Edit|Write"), or "" for all tools
 */
interface HookEntry {
  readonly type: string;
  readonly command: string;
  readonly timeout?: number;
}

interface HookMatcher {
  matcher: string;
  hooks: HookEntry[];
}

interface ClaudeSettings {
  hooks?: {
    PreToolUse?: HookMatcher[];
    PostToolUse?: HookMatcher[];
    PreCompact?: HookMatcher[];
    Stop?: HookMatcher[];
    UserPromptSubmit?: HookMatcher[];
  };
  [key: string]: unknown;
}

/**
 * Installs NoSleep monitoring hooks into a project's Claude Code settings.
 *
 * Hooks call back to the NoSleep server via HTTP to:
 * - PreToolUse: Check budget, inject goal reminders
 * - PostToolUse: Report tool usage for tracking and drift detection
 * - Stop: Trigger completeness validation
 */
export function installHooks(projectPath: string, config: HooksConfig): void {
  const targets = resolveHookTargets(projectPath, config.targets);
  if (targets.includes("claude")) installClaudeHooks(projectPath, config);
  if (targets.includes("opencode")) {
    installOpenCodeHooks(projectPath, config);
    // Same skill package, OpenCode's native dir. OpenCode v1 also reads
    // .claude/skills, but the v2 catalog only lists .opencode/skills; when a
    // name exists in both, OpenCode keeps one entry (the .opencode copy).
    writeBrainSkills(ensureDir(join(projectPath, ".opencode")));
  }
}

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function installClaudeHooks(projectPath: string, config: HooksConfig): void {
  const claudeDir = join(projectPath, ".claude");
  if (!existsSync(claudeDir)) {
    mkdirSync(claudeDir, { recursive: true });
  }

  // Write the hook scripts
  writeHookScripts(claudeDir, config);

  // Install brain skills (auto-capture, etc.) into .claude/skills/
  writeBrainSkills(claudeDir);

  // Update .claude/settings.local.json to register the hooks
  const settingsPath = join(claudeDir, "settings.local.json");
  const settings = readSettingsFile(settingsPath);

  settings.hooks = settings.hooks ?? {};

  const scriptDir = join(claudeDir, "nosleep-hooks");

  // PreToolUse hook - budget check + goal reminder (matches all tools)
  settings.hooks.PreToolUse = mergeHookMatchers(
    settings.hooks.PreToolUse,
    {
      matcher: "",
      hooks: [{
        type: "command",
        command: `node "${join(scriptDir, "pre-tool.mjs")}"`,
        timeout: 5000,
      }],
    },
    "nosleep"
  );

  // PostToolUse hook - report tool usage (matches all tools)
  settings.hooks.PostToolUse = mergeHookMatchers(
    settings.hooks.PostToolUse,
    {
      matcher: "",
      hooks: [{
        type: "command",
        command: `node "${join(scriptDir, "post-tool.mjs")}"`,
        timeout: 5000,
      }],
    },
    "nosleep"
  );

  // PreCompact hook - save goal context before Claude compacts
  settings.hooks.PreCompact = mergeHookMatchers(
    settings.hooks.PreCompact,
    {
      matcher: "",
      hooks: [{
        type: "command",
        command: `node "${join(scriptDir, "pre-compact.mjs")}"`,
        timeout: 5000,
      }],
    },
    "nosleep"
  );

  // Stop hook - trigger completeness validation
  settings.hooks.Stop = mergeHookMatchers(
    settings.hooks.Stop,
    {
      matcher: "",
      hooks: [{
        type: "command",
        command: `node "${join(scriptDir, "stop.mjs")}"`,
        timeout: 10000,
      }],
    },
    "nosleep"
  );

  // UserPromptSubmit hook - capture user messages into the brain archive
  // (Phase 12 — fixes the gap where Layer 1 had only tool calls, no chat).
  settings.hooks.UserPromptSubmit = mergeHookMatchers(
    settings.hooks.UserPromptSubmit,
    {
      matcher: "",
      hooks: [{
        type: "command",
        command: `node "${join(scriptDir, "user-prompt.mjs")}"`,
        timeout: 5000,
      }],
    },
    "nosleep"
  );

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

  // Bake the project's org into its .mcp.json so every session in this folder
  // sends a trusted x-nosleep-org header. The HTTP MCP endpoint uses that as
  // the authoritative org (a caller-supplied orgId can't override it), so
  // memory + brain artifacts are scoped to THIS project's org. A project
  // belongs to exactly one org, so this is a stable, correct binding.
  writeMcpConfig(projectPath, config);
}

/**
 * Merge the NoSleep gateway entry into a project's .mcp.json, adding the
 * trusted org header. Preserves any existing servers and fields.
 */
function writeMcpConfig(projectPath: string, config: HooksConfig): void {
  const mcpPath = join(projectPath, ".mcp.json");
  let json: { mcpServers?: Record<string, Record<string, unknown>> } = {};
  if (existsSync(mcpPath)) {
    try {
      json = JSON.parse(readFileSync(mcpPath, "utf-8"));
    } catch {
      json = {}; // corrupt → rewrite fresh
    }
  }
  json.mcpServers = json.mcpServers ?? {};
  const existing = json.mcpServers.nosleep ?? {};
  const existingHeaders = (existing.headers as Record<string, string> | undefined) ?? {};
  json.mcpServers.nosleep = {
    ...existing,
    type: (existing.type as string) ?? "http",
    url: (existing.url as string) ?? `http://localhost:${config.serverPort}/api/mcp`,
    headers: { ...existingHeaders, "x-nosleep-org": config.orgId },
  };
  writeFileSync(mcpPath, JSON.stringify(json, null, 2));
}

/**
 * Remove NoSleep hooks from a project — every target (Claude Code + OpenCode).
 */
export function uninstallHooks(projectPath: string): void {
  uninstallOpenCodeHooks(projectPath);
  uninstallClaudeHooks(projectPath);
}

function uninstallClaudeHooks(projectPath: string): void {
  const settingsPath = join(projectPath, ".claude", "settings.local.json");
  if (!existsSync(settingsPath)) return;

  const settings = readSettingsFile(settingsPath);
  if (!settings.hooks) return;

  for (const hookType of ["PreToolUse", "PostToolUse", "PreCompact", "Stop", "UserPromptSubmit"] as const) {
    const matchers = settings.hooks[hookType];
    if (Array.isArray(matchers)) {
      settings.hooks[hookType] = matchers.filter(
        (m) => !m.hooks?.some((h) => h.command.includes("nosleep-hooks"))
      );
    }
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

/**
 * Copy brain-layer skills (auto-capture, etc.) into the project's
 * .claude/skills/ directory. Idempotent: overwrites existing files so the
 * skills stay in sync with whatever the server package ships.
 */
function writeBrainSkills(claudeDir: string): void {
  const skillsDir = join(claudeDir, "skills");
  if (!existsSync(skillsDir)) mkdirSync(skillsDir, { recursive: true });

  // Resolve the installed auto-capture-skill package relative to this file.
  //   server/dist/orchestrator/hooks-installer.js  OR
  //   server/src/orchestrator/hooks-installer.ts   (tsx dev)
  // Both sit two levels below `packages/server`, so four `..` reaches `packages/`.
  const here = dirname(fileURLToPath(import.meta.url));
  const sourceSkillDir = resolve(here, "..", "..", "..", "auto-capture-skill");

  const skillMdSrc = join(sourceSkillDir, "SKILL.md");
  const metadataSrc = join(sourceSkillDir, "metadata.json");
  if (!existsSync(skillMdSrc) || !existsSync(metadataSrc)) {
    // Skill package not found — nothing to install. Non-fatal: hooks still work.
    return;
  }

  const targetDir = join(skillsDir, "auto-capture");
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

  writeFileSync(join(targetDir, "SKILL.md"), readFileSync(skillMdSrc, "utf-8"));
  writeFileSync(
    join(targetDir, "metadata.json"),
    readFileSync(metadataSrc, "utf-8"),
  );
}

// ── Internal ────────────────────────────────────────────

function writeHookScripts(claudeDir: string, config: HooksConfig): void {
  const scriptDir = join(claudeDir, "nosleep-hooks");
  if (!existsSync(scriptDir)) {
    mkdirSync(scriptDir, { recursive: true });
  }

  const baseUrl = `http://localhost:${config.serverPort}`;
  const projectPath = resolve(claudeDir, "..");

  // BUG FIX (multi-session same folder): the previous resolver cached one
  // session id in `.claude/.nosleep-session`, so a second Claude Code
  // opened in the same folder would silently reuse the first session's
  // NoSleep row. New strategy:
  //   - cache file is keyed by the Claude Code session_id passed in via
  //     hookData (one file per CC session) under .claude/.nosleep-sessions/
  //   - register call sends claudeSessionId so the server keys dedup off
  //     it instead of (project_id + 30-min window)
  // Result: each CC session gets its own NoSleep row, both surfaces.
  const sessionDir = join(claudeDir, ".nosleep-sessions");
  const resolveSessionSnippet = `
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join as _join } from "node:path";
const _sdir = "${sessionDir}";
const _base = "${baseUrl}";
const _orgId = "${config.orgId}";
const _projPath = "${projectPath}";
const _headers = (() => {
  const h = { "Content-Type": "application/json" };
  if (process.env.NOSLEEP_HOOK_SECRET) h["x-hook-secret"] = process.env.NOSLEEP_HOOK_SECRET;
  return h;
})();
async function _sid(claudeSessionId, hookCwd) {
  // Explicit override (orchestrated sessions launched by NoSleep)
  if (process.env.NOSLEEP_SESSION_ID) return process.env.NOSLEEP_SESSION_ID;
  // Per-CC-session cache so concurrent sessions in the same folder don't share rows
  let _sf = null;
  if (claudeSessionId) {
    try { mkdirSync(_sdir, { recursive: true }); } catch {}
    _sf = _join(_sdir, claudeSessionId);
    try { if (existsSync(_sf)) return readFileSync(_sf, "utf-8").trim(); } catch {}
  }
  try {
    const r = await fetch(_base + "/api/sessions/register", {
      method: "POST", headers: _headers,
      // Phase 22-B — send hookCwd alongside _projPath so the server can
      // detect git worktrees and re-attribute to the canonical project.
      // _projPath is baked at hook-install time (the dir the project
      // lives in); hookCwd reflects where Claude is actually running.
      body: JSON.stringify({ orgId: _orgId, projectPath: _projPath, claudeSessionId, cwd: hookCwd ?? _projPath }),
      signal: AbortSignal.timeout(3000),
    });
    if (r.ok) {
      const id = (await r.json()).data?.sessionId;
      if (id) {
        if (_sf) { try { writeFileSync(_sf, id); } catch {} }
        return id;
      }
    }
  } catch {}
  return null;
}
`;

  // PreToolUse hook
  writeFileSync(
    join(scriptDir, "pre-tool.mjs"),
    `// NoSleep PreToolUse hook - budget check + goal reminders + auto-register
${resolveSessionSnippet}
const hookData = JSON.parse(await new Promise(r => { let d = ""; process.stdin.on("data", c => d += c); process.stdin.on("end", () => r(d)); }));
try {
  const sessionId = await _sid(hookData.session_id, hookData.cwd);
  const res = await fetch(_base + "/api/hooks/pre-tool", {
    method: "POST", headers: _headers,
    body: JSON.stringify({ orgId: _orgId, sessionId, toolName: hookData.tool_name, toolInput: hookData.tool_input }),
    signal: AbortSignal.timeout(4000),
  });
  if (res.ok) {
    const result = await res.json();
    if (result.message) process.stdout.write(JSON.stringify(result));
  }
} catch (e) { process.stderr.write("[nosleep] hook error: " + (e?.message ?? e) + "\\n"); }
`
  );

  // PostToolUse hook
  const toolCountFile = join(claudeDir, ".nosleep-tool-count");
  writeFileSync(
    join(scriptDir, "post-tool.mjs"),
    `// NoSleep PostToolUse hook - report tool usage + count real tool calls
${resolveSessionSnippet}
const hookData = JSON.parse(await new Promise(r => { let d = ""; process.stdin.on("data", c => d += c); process.stdin.on("end", () => r(d)); }));
// Cap large tool_result payloads: Read on a big file can return MB of
// content, which previously either 413'd at the server or took >4s to
// POST and got aborted by the hook timer — surfacing as a generic
// "PostToolUse:Read hook error" red banner in the CC session. The
// truncated marker keeps the artifact lineage but skips the body.
function _truncIfBig(v, max = 65536) {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (s.length <= max) return v;
    return { _truncated: true, original_size: s.length, sample: s.slice(0, 2048) };
  } catch { return v; }
}
// toolResult must be a string (server schema). Claude Code sends the result as
// \`tool_response\` (usually an object); \`tool_result\` is the legacy name.
function _resultText(v, max = 65536) {
  if (v === undefined || v === null) return undefined;
  let s;
  try { s = typeof v === "string" ? v : JSON.stringify(v); } catch { return undefined; }
  if (s.length <= max) return s;
  return s.slice(0, 2048) + "\\n[truncated: original_size=" + s.length + "]";
}
try {
  const sessionId = await _sid(hookData.session_id, hookData.cwd);
  await fetch(_base + "/api/hooks/post-tool", {
    method: "POST", headers: _headers,
    body: JSON.stringify({
      orgId: _orgId,
      sessionId,
      toolName: hookData.tool_name,
      toolInput: _truncIfBig(hookData.tool_input, 8192),
      toolResult: _resultText(hookData.tool_response ?? hookData.tool_result),
    }),
    signal: AbortSignal.timeout(4000),
  });

  // Count real tool calls (not MCP calls) for Stop hook loop decision
  const realTools = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Agent"];
  if (realTools.includes(hookData.tool_name)) {
    const _tcf = "${toolCountFile}";
    let count = 0;
    try { count = parseInt(readFileSync(_tcf, "utf-8").trim(), 10) || 0; } catch {}
    try { writeFileSync(_tcf, String(count + 1)); } catch {}
  }
} catch (e) { process.stderr.write("[nosleep] hook error: " + (e?.message ?? e) + "\\n"); }
`
  );

  // UserPromptSubmit hook — capture user message into the brain archive
  // (Layer 1). This was missing pre-Phase-12 — only tool calls were landing.
  writeFileSync(
    join(scriptDir, "user-prompt.mjs"),
    `// NoSleep UserPromptSubmit hook - capture user message into Layer 1
${resolveSessionSnippet}
const hookData = JSON.parse(await new Promise(r => { let d = ""; process.stdin.on("data", c => d += c); process.stdin.on("end", () => r(d)); }));
// Skip brain-internal \`claude --print\` calls — their prompt is a triage
// template, not a real user message. Prevents the 2026-05-18 recursion.
if (process.env.NOSLEEP_BRAIN_INTERNAL === "1") {
  process.exit(0);
}
try {
  const sessionId = await _sid(hookData.session_id, hookData.cwd);
  // The hook payload's prompt key varies by Claude Code version — accept all.
  const prompt =
    hookData.prompt ??
    hookData.user_prompt ??
    hookData.message ??
    "";
  if (prompt) {
    await fetch(_base + "/api/brain/hook-ingest/user-prompt", {
      method: "POST", headers: _headers,
      body: JSON.stringify({ orgId: _orgId, sessionId, prompt }),
      signal: AbortSignal.timeout(4000),
    });
  }
} catch (e) { process.stderr.write("[nosleep] user-prompt hook error: " + (e?.message ?? e) + "\\n"); }
`
  );

  // PreCompact hook
  writeFileSync(
    join(scriptDir, "pre-compact.mjs"),
    `// NoSleep PreCompact hook - save context before Claude compacts
${resolveSessionSnippet}
const hookData = JSON.parse(await new Promise(r => { let d = ""; process.stdin.on("data", c => d += c); process.stdin.on("end", () => r(d)); }));
try {
  const sessionId = await _sid(hookData.session_id, hookData.cwd);
  await fetch(_base + "/api/hooks/pre-compact", {
    method: "POST", headers: _headers,
    body: JSON.stringify({ orgId: _orgId, sessionId, summary: hookData.summary }),
    signal: AbortSignal.timeout(4000),
  });
} catch (e) { process.stderr.write("[nosleep] hook error: " + (e?.message ?? e) + "\\n"); }
`
  );

  // Stop hook - asks Haiku what to do, blocks exit if next task available
  const lastTaskFile = join(claudeDir, ".nosleep-last-task");
  writeFileSync(
    join(scriptDir, "stop.mjs"),
    `// NoSleep Stop hook - decides whether to continue or exit
${resolveSessionSnippet}
const hookData = JSON.parse(await new Promise(r => { let d = ""; process.stdin.on("data", c => d += c); process.stdin.on("end", () => r(d)); }));
// Brain-internal \`claude --print\` spawns set NOSLEEP_BRAIN_INTERNAL=1.
// Their transcripts are NOT real conversations — ingesting them re-feeds
// the brain its own prompts and recurses (incident 2026-05-18).
if (process.env.NOSLEEP_BRAIN_INTERNAL === "1") {
  process.exit(0);
}
try {
  const sessionId = await _sid(hookData.session_id, hookData.cwd);
  // Per-CC-session cache path resolved in the main scope so the cleanup
  // calls below can find it (it used to be _sid()-local → undefined here).
  const _sf = hookData.session_id ? _join(_sdir, hookData.session_id) : null;
  const _lastTaskFile = "${lastTaskFile}";
  const _toolCountFile = "${join(claudeDir, ".nosleep-tool-count")}";
  const _loopActiveFile = "${join(claudeDir, ".nosleep-loop-active")}";
  const _connectedFile = "${join(claudeDir, ".nosleep-connected")}";

  // BUG FIX: previously the entire Stop hook returned early when the
  // nosleep-go loop was inactive, so 99% of sessions never had their
  // transcript ingested. Now we always run the brain transcript fan-out
  // (cheap, idempotent) and only the loop-continuation logic remains
  // gated. Without this, user/assistant turns never reach the brain and
  // auto_thought has nothing to lift.
  if (hookData.transcript_path) {
    try {
      await fetch(_base + "/api/brain/hook-ingest/transcript", {
        method: "POST", headers: _headers,
        body: JSON.stringify({
          orgId: _orgId,
          sessionId,
          transcriptPath: hookData.transcript_path,
        }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) { process.stderr.write("[nosleep] transcript ingest error: " + (e?.message ?? e) + "\\n"); }
  }

  // Steering down-channel — a CONNECTED session (/nosleep-connect or
  // /nosleep-go) is steerable from the dashboard/mobile: those enqueue a
  // message server-side; here we drain it and inject it as the next turn.
  // This makes a non-wrapped local session remotely steerable — the
  // reliable equivalent of Anthropic Remote Control, on our own relay.
  if (existsSync(_connectedFile)) {
    try {
      const dr = await fetch(_base + "/api/sessions/" + sessionId + "/drain", {
        method: "POST", headers: _headers, signal: AbortSignal.timeout(4000),
      });
      if (dr.ok) {
        const steerMsg = (await dr.json())?.data?.message;
        if (steerMsg) {
          process.stdout.write(JSON.stringify({ decision: "block", reason: steerMsg }));
          process.exit(0);
        }
      }
    } catch (e) { process.stderr.write("[nosleep] steer drain error: " + (e?.message ?? e) + "\\n"); }
  }

  // Only loop if /nosleep-go was called (loop is opt-in)
  if (!existsSync(_loopActiveFile)) {
    try { if (existsSync(_sf)) unlinkSync(_sf); } catch {}
    process.exit(0);
  }

  // Check tool call count since last injection — if < 5 real tools, Claude didn't do real work
  let toolCount = 0;
  try { toolCount = parseInt(readFileSync(_toolCountFile, "utf-8").trim(), 10) || 0; } catch {}

  if (toolCount < 5) {
    // Claude didn't do enough work — allow exit, don't loop
    try { if (existsSync(_sf)) unlinkSync(_sf); } catch {}
    try { unlinkSync(_lastTaskFile); } catch {}
    process.exit(0);
  }

  // The loop brain lives server-side (decide-next reads the AI-controllable
  // project_loops config: mode continue/content/branch, the no-progress guard,
  // branch auto-stop, and enabled). Report stop, ask what's next, and — unless
  // the brain says stop — hand off a ONE-SHOT wake \`delayMinutes\` out so this
  // session ENDS and the scheduler relaunches during dead time (cron
  // piggyback). No immediate block-and-continue: "wait N min, don't fuckout".
  // The AI changes mode/content/branch/interval or disables the loop via the
  // nosleep gateway (loop_set / loop_stop).
  try {
    await fetch(_base + "/api/hooks/stop", {
      method: "POST", headers: _headers,
      body: JSON.stringify({ orgId: _orgId, sessionId, stopReason: hookData.stop_reason }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {}

  try {
    const decisionRes = await fetch(_base + "/api/sessions/" + sessionId + "/decide-next", {
      method: "POST", headers: _headers,
      body: JSON.stringify({ stopReason: hookData.stop_reason }),
      signal: AbortSignal.timeout(15000),
    });
    if (decisionRes.ok) {
      const d = (await decisionRes.json())?.data;
      if (d && d.action && d.action !== "stop") {
        const delay = (typeof d.delayMinutes === "number" && d.delayMinutes >= 1)
          ? Math.floor(d.delayMinutes) : 10;
        try {
          await fetch(_base + "/api/sessions/" + sessionId + "/schedule-wake", {
            method: "POST", headers: _headers,
            body: JSON.stringify({ delayMinutes: delay }),
            signal: AbortSignal.timeout(5000),
          });
        } catch (e) { process.stderr.write("[nosleep] schedule-wake error: " + (e?.message ?? e) + "\\n"); }
      }
      // action === "stop" (disabled / nothing to do / branch complete /
      // no-progress) → no wake scheduled; the loop ends here.
    }
  } catch (e) { process.stderr.write("[nosleep] decide-next error: " + (e?.message ?? e) + "\\n"); }

  // Allow exit; clean up.
  try { unlinkSync(_lastTaskFile); } catch {}
  try { if (_sf && existsSync(_sf)) unlinkSync(_sf); } catch {}
  process.exit(0);
} catch (e) {
  process.stderr.write("[nosleep] stop hook error: " + (e?.message ?? e) + "\\n");
  // On error: allow exit
  try { if (existsSync(_sf)) unlinkSync(_sf); } catch {}
}
`
  );
}

function readSettingsFile(path: string): ClaudeSettings {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ClaudeSettings;
  } catch {
    return {};
  }
}

/**
 * Merge a new hook matcher into existing matchers, replacing any with nosleep commands.
 * Also removes old-format flat entries (pre-matcher schema) that contain the identifier.
 */
function mergeHookMatchers(
  existing: unknown[] | undefined,
  newMatcher: HookMatcher,
  identifier: string,
): HookMatcher[] {
  const matchers: HookMatcher[] = [];
  for (const entry of existing ?? []) {
    const e = entry as Record<string, unknown>;
    // Skip old-format flat entries { type, command } that contain nosleep
    if (typeof e.command === "string" && (e.command as string).includes(identifier)) continue;
    // Skip new-format entries { matcher, hooks } that contain nosleep
    if (Array.isArray(e.hooks) && (e.hooks as HookEntry[]).some((h) => h.command.includes(identifier))) continue;
    matchers.push(entry as HookMatcher);
  }
  matchers.push(newMatcher);
  return matchers;
}

/** The minimal global registration hook. Register-only (no goal/budget/loop
 *  orchestration), fail-open, skips headless brain calls. Kept identical to
 *  the runtime artifact at ~/.claude/nosleep-hooks/global-register.mjs. */
function globalRegisterScript(serverPort: number, defaultOrg: string): string {
  return `// NoSleep GLOBAL session-registration hook (UserPromptSubmit) — generated.
// Registers EVERY Claude Code session (any folder) so it is visible in the
// dashboard. Register-only: no goal/budget/loop orchestration. Fail-open.
const BASE = "http://localhost:${serverPort}";
const DEFAULT_ORG = "${defaultOrg}"; // register resolves the TRUE org by path
async function main() {
  if (process.env.NOSLEEP_BRAIN_INTERNAL === "1") return;
  // Orchestrator-launched sessions already have a managed session row (the
  // spawner sets NOSLEEP_SESSION_ID). Registering them again created a
  // phantom "Manual CLI session" twin for every loop/scheduled run.
  if (process.env.NOSLEEP_SESSION_ID) return;
  // Headless one-shot runs (validator/brain/SDK headlessQuery) execute in the
  // ~/.nosleep/headless scratch cwd — not user sessions; registering them
  // created ghost "running" rows. Skip by cwd (works even without the env tag).
  if (/\\/\\.nosleep\\/headless\\/?$/.test(process.cwd())) return;
  let input = "";
  try { process.stdin.setEncoding("utf8"); for await (const c of process.stdin) input += c; } catch {}
  let hook = {};
  try { hook = JSON.parse(input || "{}"); } catch { return; }
  const cwd = hook.cwd || process.cwd();
  const headers = { "Content-Type": "application/json" };
  if (process.env.NOSLEEP_HOOK_SECRET) headers["x-hook-secret"] = process.env.NOSLEEP_HOOK_SECRET;
  try {
    await fetch(BASE + "/api/sessions/register", {
      method: "POST", headers,
      body: JSON.stringify({ orgId: DEFAULT_ORG, projectPath: cwd, claudeSessionId: hook.session_id, cwd }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {}
}
main().catch(() => {}).finally(() => process.exit(0));
`;
}

/**
 * Install (or refresh) the GLOBAL session-registration hook in
 * ~/.claude/settings.json so every Claude Code session — in any folder — is
 * visible in NoSleep. Idempotent. Does NOT install the orchestration suite
 * (PreToolUse budget/goal, Stop loop) — that stays per-project.
 */
export function installGlobalHooks(serverPort: number, defaultOrg = "org_personal"): void {
  const claudeDir = join(homedir(), ".claude");
  const scriptDir = join(claudeDir, "nosleep-hooks");
  if (!existsSync(scriptDir)) mkdirSync(scriptDir, { recursive: true });

  const scriptPath = join(scriptDir, "global-register.mjs");
  writeFileSync(scriptPath, globalRegisterScript(serverPort, defaultOrg));

  const settingsPath = join(claudeDir, "settings.json");
  const settings = readSettingsFile(settingsPath);
  settings.hooks = settings.hooks ?? {};
  settings.hooks.UserPromptSubmit = mergeHookMatchers(
    settings.hooks.UserPromptSubmit,
    {
      matcher: "",
      hooks: [{ type: "command", command: `node "${scriptPath}"`, timeout: 5000 }],
    },
    "nosleep-hooks/global-register",
  );
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

/** Remove the global registration hook from ~/.claude/settings.json. */
export function uninstallGlobalHooks(): void {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  if (!existsSync(settingsPath)) return;
  const settings = readSettingsFile(settingsPath);
  const ups = settings.hooks?.UserPromptSubmit;
  if (Array.isArray(ups)) {
    settings.hooks!.UserPromptSubmit = ups.filter(
      (m) => !(Array.isArray(m.hooks) && m.hooks.some((h) => h.command.includes("global-register"))),
    );
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}
