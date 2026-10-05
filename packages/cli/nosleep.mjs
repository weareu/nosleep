#!/usr/bin/env node

/**
 * nosleep — wrapper around `claude` CLI.
 * Full TUI, you type normally, AND NoSleep can inject messages remotely.
 * When Claude finishes a task, injects the next one into the SAME session.
 * Context is preserved — no cold starts.
 *
 * Usage:
 *   nosleep claude --continue
 *   nosleep claude "fix the login bug"
 *   nosleep claude
 */

import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PTY_WRAP = join(__dirname, "pty-wrap.py");
const SERVER_URL = process.env.NOSLEEP_SERVER_URL ?? "http://localhost:3777";
const API_KEY = process.env.NOSLEEP_API_KEY ?? "";
const CWD = process.cwd();
const POLL_INTERVAL_MS = 3000;

function findClaude() {
  for (const p of [`${process.env.HOME}/.local/bin/claude`, "/usr/local/bin/claude", "/opt/homebrew/bin/claude"]) {
    if (existsSync(p)) return p;
  }
  try { return execFileSync("which", ["claude"], { encoding: "utf-8" }).trim(); }
  catch { return "claude"; }
}

async function api(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (API_KEY) headers["x-api-key"] = API_KEY;
  try {
    const res = await fetch(`${SERVER_URL}${path}`, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    return await res.json();
  } catch { return null; }
}

function findOrgId() {
  const hookPath = join(CWD, ".claude", "nosleep-hooks", "pre-tool.mjs");
  if (!existsSync(hookPath)) return null;
  const match = readFileSync(hookPath, "utf-8").match(/const _orgId = "([^"]+)"/);
  return match ? match[1] : null;
}

async function registerSession() {
  const orgId = findOrgId();
  if (!orgId) { console.error("[nosleep] No org. Run in a hooked project."); return null; }
  const result = await api("POST", "/api/sessions/register", { orgId, projectPath: CWD });
  if (result?.success) {
    const sid = result.data.sessionId;
    try { writeFileSync(join(CWD, ".claude", ".nosleep-session"), sid); } catch {}
    return { sessionId: sid, projectId: result.data.projectId, reused: result.data.reused };
  }
  return null;
}

async function getNextTask(projectId) {
  try {
    const result = await api("GET", `/api/strategy/tree/${encodeURIComponent(projectId)}/next`);
    if (result?.success && result.data?.id) return result.data;
  } catch {}
  return null;
}

async function main() {
  const claudeBin = findClaude();
  let args = process.argv.slice(2);
  if (args[0] === "claude") args = args.slice(1);

  const session = await registerSession();
  if (session) {
    console.error(`[nosleep] Session ${session.reused ? "reused" : "registered"}: ${session.sessionId.slice(0, 16)} (${session.projectId.slice(0, 8)})`);
  }

  const env = { ...process.env };
  if (session) env.NOSLEEP_SESSION_ID = session.sessionId;
  delete env.CLAUDECODE;

  const injectPipe = join(CWD, ".claude", ".nosleep-inject");

  // Spawn Claude through PTY wrapper
  const child = spawn("python3", [PTY_WRAP, injectPipe, claudeBin, ...args], {
    cwd: CWD, env, stdio: "inherit",
  });

  // Server message polling only — no idle injection

  // Auto-kickoff for --continue with no prompt
  const hasContinue = args.includes("--continue") || args.some(a => a.startsWith("--resume"));
  const hasPrompt = args.some(a => !a.startsWith("-") && a.length > 0);
  if (hasContinue && !hasPrompt) {
    setTimeout(() => {
      try {
        appendFileSync(injectPipe, 'If you were working on something, continue. If you can decide the best path, do that. Otherwise call nosleep(action="strategy_next") for the next task.\n');
      } catch {}
    }, 3000);
  }

  // Poll for injected messages from server (phone, scheduler, etc.)
  let pollTimer = null;
  if (session) {
    pollTimer = setInterval(async () => {
      try {
        const result = await api("POST", `/api/sessions/${session.sessionId}/drain`, {});
        const msg = result?.success && result.data?.message;
        if (msg) {
          try { appendFileSync(injectPipe, msg + "\n"); } catch {}
        }
      } catch {}
    }, POLL_INTERVAL_MS);
  }

  // NO idle injection — only the Stop hook triggers next task.
  // The wrapper just polls for server-injected messages (from phone, scheduler, etc.)

  child.on("exit", async (code) => {
    if (pollTimer) clearInterval(pollTimer);

    // If Claude exited cleanly, ask Haiku what to do next
    if (code === 0 && session) {
      try {
        const decision = await api("POST", `/api/sessions/${session.sessionId}/decide-next`, {
          stopReason: "end_turn",
        });

        if (decision?.success && decision.data) {
          const { action, response, nextTask, projectName } = decision.data;

          if (action === "next_task" && nextTask) {
            const criteria = Array.isArray(nextTask.acceptanceCriteria) ? nextTask.acceptanceCriteria : [];
            const criteriaText = criteria.length > 0
              ? "\nAcceptance Criteria:\n" + criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")
              : "";

            console.error(`\n[nosleep] ─── Haiku says: next_task ───`);
            console.error(`[nosleep] ${response}`);
            console.error(`[nosleep] Next: [${nextTask.type}] ${nextTask.title}`);
            console.error(`[nosleep] Re-launching in 5s (Ctrl+C to stop)\n`);

            let cancelled = false;
            process.once("SIGINT", () => { cancelled = true; });
            await new Promise(r => setTimeout(r, 5000));
            if (!cancelled) {
              const goal = `[${nextTask.type}] ${nextTask.title}\n${nextTask.description ?? ""}${criteriaText}\n\nUse the "nosleep" MCP tool: nosleep(action="strategy_update", params={nodeId:"${nextTask.id}", status:"in_progress"}) then start working.`;

              const newSession = await registerSession();
              if (newSession) env.NOSLEEP_SESSION_ID = newSession.sessionId;

              const nextChild = spawn("python3", [PTY_WRAP, injectPipe, claudeBin, "--continue", goal], {
                cwd: CWD, env, stdio: "inherit",
              });
              nextChild.on("exit", (c) => {
                try { unlinkSync(join(CWD, ".claude", ".nosleep-session")); } catch {}
                try { unlinkSync(injectPipe); } catch {}
                process.exit(c ?? 0);
              });
              process.on("SIGINT", () => {});
              process.on("SIGTERM", () => nextChild.kill());
              return;
            }
            console.error("[nosleep] Cancelled.");

          } else if (action === "escalate") {
            console.error(`\n[nosleep] ─── Haiku says: escalate ───`);
            console.error(`[nosleep] ${response}`);
            console.error(`[nosleep] Check alerts on your phone.\n`);

          } else {
            console.error(`\n[nosleep] ─── Haiku says: ${action} ───`);
            console.error(`[nosleep] ${response}\n`);
          }
        }
      } catch (err) {
        console.error(`[nosleep] Decision failed: ${err.message ?? err}`);
      }
    }

    try { unlinkSync(join(CWD, ".claude", ".nosleep-session")); } catch {}
    try { unlinkSync(injectPipe); } catch {}
    process.exit(code ?? 0);
  });

  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => child.kill());
  process.stdout.on("resize", () => {
    try { child.kill("SIGWINCH"); } catch {}
  });
}

main().catch(err => { console.error("[nosleep] Fatal:", err.message); process.exit(1); });
