#!/usr/bin/env node
/**
 * NoSleep doctor — non-interactive health check of an install.
 *
 *   node scripts/doctor.mjs            (same as: node scripts/setup.mjs doctor / npm run doctor)
 *   flags: --root <dir> (or NOSLEEP_SETUP_ROOT) check another checkout/config root
 *          --no-llm-test  skip the live chat-completion probe
 *
 * Never starts the server; only probes it. Exit 1 when any check FAILs.
 * Also exports the LLM probing helpers the setup wizard shares.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MIN_NODE_MAJOR, MODEL_FILES, REPO, SERVER_PORT, parseEnv, which } from "./install.mjs";

export const LOCAL_ENDPOINTS = [
  { name: "Ollama", baseUrl: "http://localhost:11434/v1" },
  { name: "LM Studio", baseUrl: "http://localhost:1234/v1" },
];

const SECRET_KEY = /(KEY|SECRET|TOKEN|PASSWORD)/i;

/** Never show a secret in full: "sk-o… (51 chars)". */
export function maskSecret(value) {
  if (!value) return "(empty)";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}… (${value.length} chars)`;
}

/** Human diff of two .env bodies (active keys only), secrets masked. */
export function envDiff(before, after) {
  const a = parseEnv(before);
  const b = parseEnv(after);
  const show = (k, v) => (SECRET_KEY.test(k) ? maskSecret(v) : v === "" ? "(empty)" : v);
  const lines = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!(k in b)) lines.push(`- ${k}`);
    else if (!(k in a)) lines.push(`+ ${k}=${show(k, b[k])}`);
    else if (a[k] !== b[k]) lines.push(`~ ${k}: ${show(k, a[k])} -> ${show(k, b[k])}`);
  }
  return lines;
}

const errText = (err) => {
  const code = err?.cause?.code ?? err?.code;
  if (code === "ECONNREFUSED") return "connection refused (is the server running?)";
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timed out";
  if (code === "ENOTFOUND") return "host not found";
  return err?.message ?? String(err);
};

/** GET <base>/models on each candidate; returns the reachable ones with model ids. */
export async function detectLocalEndpoints(candidates = LOCAL_ENDPOINTS, { timeoutMs = 1500, fetchImpl = fetch } = {}) {
  const found = await Promise.all(candidates.map(async (c) => {
    try {
      const models = await listModels(c.baseUrl, { timeoutMs, fetchImpl });
      return { ...c, models };
    } catch {
      return null;
    }
  }));
  return found.filter(Boolean);
}

export async function listModels(baseUrl, { apiKey, timeoutMs = 5000, fetchImpl = fetch } = {}) {
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/models`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return (Array.isArray(body?.data) ? body.data : []).map((m) => m?.id).filter((id) => typeof id === "string");
}

/** Extract a JSON object from a model reply the way the server's callers
 *  tolerate it: reasoning blocks and ```json fences are ignored. */
export function extractJson(text) {
  const cleaned = String(text).replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const v = JSON.parse(cleaned.slice(start, end + 1));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/**
 * One tiny Chat Completions call, shaped like the server's (temperature 0).
 * Returns { ok, latencyMs, json, reply?, error?, hint? } — never throws.
 */
export async function testChatCompletion({ baseUrl, model, apiKey, timeoutMs = 45_000, fetchImpl = fetch }) {
  const t0 = Date.now();
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 60,
        messages: [{ role: "user", content: 'Reply with exactly this JSON and nothing else: {"ok": true, "sum": 5}' }],
      }),
    });
    const latencyMs = Date.now() - t0;
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? "check the API key"
        : res.status === 404 ? "model not found or wrong base URL (it must end in /v1)"
        : res.status === 429 ? "rate limited / out of credit" : undefined;
      return { ok: false, latencyMs, json: false, error: `HTTP ${res.status}`, hint };
    }
    const body = await res.json();
    const reply = body?.choices?.[0]?.message?.content ?? "";
    const parsed = extractJson(reply);
    return { ok: true, latencyMs, json: parsed !== null, reply: String(reply).slice(0, 200) };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, json: false, error: errText(err) };
  }
}

/** Run the SERVER's own resolveLlmRoute/describeLlmRouting (via tsx) against
 *  an env, so the wizard and doctor validate exactly what startup validates.
 *  Returns { line, routes, error } or { unavailable: reason }. */
export function serverRouting(fileEnv, { repo = REPO, baseEnv = process.env } = {}) {
  if (!existsSync(join(repo, "node_modules", "tsx", "package.json"))) {
    return { unavailable: "dependencies not installed (run node scripts/install.mjs)" };
  }
  const file = pathToFileURL(join(repo, "packages", "server", "src", "lib", "headless-claude.ts")).href;
  const code = `const m = await import(${JSON.stringify(file)});
const out = { line: null, routes: {}, error: null };
try { out.line = m.describeLlmRouting(process.env); for (const p of m.LLM_PURPOSES) out.routes[p] = m.resolveLlmRoute(p, process.env); }
catch (e) { out.error = String(e?.message ?? e); }
process.stdout.write("\\n@@ROUTING@@" + JSON.stringify(out));`;
  // The service sees only .env (dotenv), so shell NOSLEEP_LLM_* must not leak in.
  const env = Object.fromEntries(Object.entries(baseEnv).filter(([k]) => !k.startsWith("NOSLEEP_LLM_")));
  const r = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: join(repo, "packages", "server"), env: { ...env, ...fileEnv }, encoding: "utf8", timeout: 30_000,
  });
  const marker = (r.stdout ?? "").lastIndexOf("@@ROUTING@@");
  if (marker === -1) return { unavailable: `routing check failed: ${(r.stderr || r.error?.message || "no output").trim().split("\n")[0]}` };
  return JSON.parse(r.stdout.slice(marker + "@@ROUTING@@".length));
}

export function venvPython(venvDir) {
  return platform() === "win32" ? join(venvDir, "Scripts", "python.exe") : join(venvDir, "bin", "python");
}

export function notebookAuthPath(env = process.env) {
  return env.NOTEBOOKLM_AUTH_JSON || join(homedir(), ".notebooklm", "storage_state.json");
}

const STATUS = { ok: "[ ok ]", warn: "[warn]", fail: "[FAIL]", skip: "[skip]", info: "[info]" };

/**
 * Run every check. `root` holds the config (.env, data/models, mobile
 * .env.local, research .venv); code checks run against the repo itself.
 */
export async function runDoctor({ root = REPO, out = (s) => process.stdout.write(`${s}\n`), env = process.env,
  fetchImpl = fetch, llmTest = true, repo = REPO } = {}) {
  const checks = [];
  const add = (status, name, detail = "") => {
    checks.push({ status, name, detail });
    out(`${STATUS[status]} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  const major = Number(process.versions.node.split(".")[0]);
  add(major >= MIN_NODE_MAJOR ? "ok" : "fail", "Node", `${process.versions.node} (need ${MIN_NODE_MAJOR}+)`);

  const claude = which("claude");
  if (!claude) add("fail", "claude CLI", "not on PATH — install Claude Code and run `claude` once to log in");
  else {
    const v = spawnSync(claude, ["--version"], { encoding: "utf8", timeout: 15_000, shell: platform() === "win32" });
    add(v.status === 0 ? "ok" : "warn", "claude CLI", `${claude} ${(v.stdout ?? "").trim()}`);
  }

  const envPath = join(root, ".env");
  let fileEnv = {};
  if (!existsSync(envPath)) add("fail", ".env", `missing at ${envPath} — run node scripts/install.mjs`);
  else {
    fileEnv = parseEnv(readFileSync(envPath, "utf8"));
    const missing = ["NOSLEEP_API_KEY", "NOSLEEP_HOOK_SECRET"].filter((k) => !fileEnv[k]);
    add(missing.length ? "fail" : "ok", ".env keys", missing.length ? `blank: ${missing.join(", ")} (re-run install.mjs)` : "NOSLEEP_API_KEY + NOSLEEP_HOOK_SECRET set");
    if (platform() !== "win32" && (statSync(envPath).mode & 0o077) !== 0) {
      add("warn", ".env permissions", `readable by others — chmod 600 ${envPath}`);
    }
  }

  const modelDir = join(root, "data", "models");
  const missingModels = MODEL_FILES.filter(([, f]) => !existsSync(join(modelDir, f))).map(([, f]) => f);
  add(missingModels.length ? "warn" : "ok", "embedding model",
    missingModels.length ? `missing ${missingModels.join(", ")} — semantic search off (re-run install.mjs)` : modelDir);

  const sqlite = spawnSync(process.execPath, ["-e", "new (require('better-sqlite3'))(':memory:').prepare('select 1').get()"],
    { cwd: join(repo, "packages", "server"), encoding: "utf8", timeout: 20_000 });
  add(sqlite.status === 0 ? "ok" : "fail", "better-sqlite3",
    sqlite.status === 0 ? `loads under Node ${process.versions.node}` : `${(sqlite.stderr || "").trim().split("\n").find((l) => /Error/.test(l)) ?? "failed"} — npm rebuild better-sqlite3`);

  const port = Number(fileEnv.PORT) || SERVER_PORT;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    add(res.ok ? "ok" : "warn", "server", `http://127.0.0.1:${port}/health → HTTP ${res.status}`);
  } catch (err) {
    add("warn", "server", `not reachable on :${port} (${errText(err)}) — start: npm run dev:server, or node scripts/install.mjs --service`);
  }

  add("info", "brain", `triage ${fileEnv.NOSLEEP_BRAIN_DISABLE_TRIAGE === "1" ? "OFF" : "on"}, consolidator ${fileEnv.NOSLEEP_BRAIN_CONSOLIDATE || "on (default)"}`);

  if (existsSync(envPath)) {
    const routing = serverRouting(fileEnv, { repo, baseEnv: env });
    if (routing.unavailable) add("skip", "llm routing", routing.unavailable);
    else if (routing.error) add("fail", "llm routing", `${routing.error} — the server will refuse to start`);
    else {
      add("ok", "llm routing", routing.line.replace(/^llm routing: /, ""));
      const tested = new Map();
      for (const [purpose, r] of Object.entries(routing.routes)) {
        if (r.provider !== "openai") continue;
        if (!llmTest) { add("skip", `llm ${purpose}`, "live test disabled"); continue; }
        const key = `${r.baseUrl}|${r.model}|${r.apiKey ?? ""}`;
        if (!tested.has(key)) tested.set(key, await testChatCompletion({ ...r, fetchImpl }));
        const t = tested.get(key);
        add(t.ok && t.json ? "ok" : t.ok ? "warn" : "fail", `llm ${purpose}`,
          t.ok ? `${r.model} answered in ${t.latencyMs} ms, JSON ${t.json ? "yes" : "NO (callers will skip items)"}`
            : `${r.model} @ ${r.baseUrl}: ${t.error}${t.hint ? ` — ${t.hint}` : ""}${r.fallback === "claude" ? " (falls back to Claude)" : ""}`);
      }
    }
  }

  const venv = join(root, "packages", "mcp-research", ".venv");
  if (!existsSync(venvPython(venv))) add("skip", "NotebookLM research", "not set up (optional — npm run setup)");
  else {
    const imp = spawnSync(venvPython(venv), ["-c", "import nosleep_research, notebooklm"], { encoding: "utf8", timeout: 30_000 });
    const auth = existsSync(notebookAuthPath(env));
    add(imp.status !== 0 ? "fail" : auth ? "ok" : "warn", "NotebookLM research",
      imp.status !== 0 ? "venv present but packages missing — re-run setup research step"
        : auth ? `venv + Google login (${notebookAuthPath(env)})` : "venv ok, not logged in — python -m nosleep_research.auth");
  }

  const mobileEnv = join(root, "packages", "mobile", ".env.local");
  if (existsSync(mobileEnv)) {
    const m = parseEnv(readFileSync(mobileEnv, "utf8"));
    add("info", "mobile", `bundle ${m.NOSLEEP_BUNDLE_ID || "dev.nosleep.app"}, server URL ${m.EXPO_PUBLIC_NOSLEEP_URL || "(LAN discovery only)"}`);
  }

  const failed = checks.filter((c) => c.status === "fail").length;
  out(failed ? `\n${failed} check(s) failed.` : "\nAll required checks passed.");
  return { checks, failed };
}

export function rootFromArgs(argv, env = process.env) {
  const i = argv.indexOf("--root");
  return resolve(i !== -1 && argv[i + 1] ? argv[i + 1] : env.NOSLEEP_SETUP_ROOT || REPO);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  runDoctor({ root: rootFromArgs(argv), llmTest: !argv.includes("--no-llm-test") })
    .then((r) => process.exit(r.failed ? 1 : 0))
    .catch((err) => { process.stderr.write(`doctor failed: ${err.message}\n`); process.exit(2); });
}
