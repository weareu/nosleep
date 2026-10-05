#!/usr/bin/env node
/**
 * NoSleep configuration wizard (npm run setup). Node built-ins only.
 *
 *   node scripts/setup.mjs                 interactive, every step skippable + re-runnable
 *   node scripts/setup.mjs --yes           accept every default (current values; no installs)
 *   node scripts/setup.mjs --dry-run       show the planned .env diff (secrets masked), write nothing
 *   node scripts/setup.mjs --steps llm,brain,mobile   run only these steps
 *   node scripts/setup.mjs doctor          non-interactive health check (npm run doctor)
 *   --root <dir> / NOSLEEP_SETUP_ROOT      configure another root (tests); steps that would touch
 *                                          ~/.claude, autostart or the live server only PRINT then.
 *
 * Steps: llm (memory/background AI routing), brain, research (NotebookLM),
 * claude (Claude Code / OpenCode integration), mobile, service, doctor.
 * Docs: docs/setup.md.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  REPO, SERVER_PORT, installService, loadEnvBody, mergeEnv, parseEnv, renderServices, which, writeEnvFile,
} from "./install.mjs";
import {
  LOCAL_ENDPOINTS, detectLocalEndpoints, envDiff, maskSecret, notebookAuthPath, rootFromArgs, runDoctor, serverRouting,
  testChatCompletion, venvPython,
} from "./doctor.mjs";

export const PURPOSES = ["brain", "validator", "responder", "vision"];
export const STEP_IDS = ["llm", "brain", "research", "claude", "mobile", "service", "doctor"];
const OLLAMA_URL = "http://localhost:11434/v1";
const OPENROUTER_URL = "https://openrouter.ai/api/v1";
const IS_WIN = platform() === "win32";

// ── pure helpers (unit-tested) ─────────────────────────────────────

/** Server URL candidates for the phone: Tailscale (100.64.0.0/10) first, then LAN IPv4. */
export function networkCandidates(ifaces = networkInterfaces(), port = SERVER_PORT) {
  const out = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      const family = a.family === 4 ? "IPv4" : a.family;
      if (family !== "IPv4" || a.internal || a.address.startsWith("169.254.")) continue;
      const [o1, o2] = a.address.split(".").map(Number);
      const tailscale = o1 === 100 && o2 >= 64 && o2 <= 127;
      out.push({ kind: tailscale ? "tailscale" : "lan", iface: name, url: `http://${a.address}:${port}` });
    }
  }
  return out.sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "tailscale" ? -1 : 1));
}

export const isVisionModel = (id) => /(vl\b|vl:|-vl|llava|vision|minicpm-v|moondream|pixtral|gemma3)/i.test(id);

/** The configured choice for a purpose, read with the server's precedence
 *  (<KEY>_<PURPOSE> over <KEY>; vision never inherits the model). The server's
 *  own resolveLlmRoute validates the result — see serverRouting(). */
export function currentLlmChoice(env, purpose) {
  const sfx = `_${purpose.toUpperCase()}`;
  const pick = (k) => env[`${k}${sfx}`] || (purpose === "vision" && k === "NOSLEEP_LLM_MODEL" ? "" : env[k] || "");
  const provider = pick("NOSLEEP_LLM_PROVIDER") || "claude";
  const baseUrl = pick("NOSLEEP_LLM_BASE_URL") || OLLAMA_URL;
  const model = pick("NOSLEEP_LLM_MODEL");
  const apiKey = pick("NOSLEEP_LLM_API_KEY");
  if (provider !== "openai") return { kind: "claude" };
  if (!model && purpose === "vision") return { kind: "off" };
  const local = /^https?:\/\/(localhost|127\.|\[::1\]|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(baseUrl);
  return { kind: local ? "local" : "hosted", baseUrl, model, apiKey };
}

/** The .env updates that make `purpose` resolve to `choice`, touching only
 *  that purpose's keys. */
export function llmUpdates(env, purpose, choice) {
  const sfx = `_${purpose.toUpperCase()}`;
  const k = (key) => `${key}${sfx}`;
  const globalOpenai = env.NOSLEEP_LLM_PROVIDER === "openai";
  if (choice.kind === "claude") return { [k("NOSLEEP_LLM_PROVIDER")]: globalOpenai ? "claude" : null };
  if (choice.kind === "off") return { [k("NOSLEEP_LLM_PROVIDER")]: "openai", [k("NOSLEEP_LLM_MODEL")]: null };
  return {
    [k("NOSLEEP_LLM_PROVIDER")]: "openai",
    [k("NOSLEEP_LLM_BASE_URL")]: choice.baseUrl,
    [k("NOSLEEP_LLM_MODEL")]: choice.model,
    [k("NOSLEEP_LLM_API_KEY")]: choice.apiKey || null,
    ...(choice.fallback !== undefined ? { [k("NOSLEEP_LLM_FALLBACK")]: choice.fallback } : {}),
    ...(choice.timeoutMs !== undefined ? { [k("NOSLEEP_LLM_TIMEOUT_MS")]: choice.timeoutMs } : {}),
  };
}

// ── prompter ───────────────────────────────────────────────────────

/**
 * Line-based prompts over node:readline. Lines are consumed through the async
 * iterator, so piped/pre-buffered input works the same as a TTY. With
 * `yes`, every prompt returns its default; after EOF too.
 */
export function createPrompter({ yes = false, input = process.stdin, output = process.stdout } = {}) {
  let muted = false;
  const echo = new Writable({ write(chunk, _enc, cb) { if (!muted) output.write(chunk); cb(); } });
  let rl = null;
  let lines = null;
  let eof = yes;
  const say = (s) => output.write(s);
  async function line() {
    if (eof) return null;
    if (!rl) {
      rl = createInterface({ input, output: echo, terminal: Boolean(input.isTTY) });
      lines = rl[Symbol.asyncIterator]();
    }
    const r = await lines.next();
    if (r.done) { eof = true; return null; }
    return r.value;
  }
  async function raw(prompt, shownDefault, { secret = false } = {}) {
    say(`? ${prompt}${shownDefault ? ` [${shownDefault}]` : ""} `);
    if (eof) { say(`${yes ? "(--yes)" : "(no input)"}\n`); return ""; }
    muted = secret;
    const v = await line();
    muted = false;
    if (v === null) say("(no input)\n");
    else if (secret && input.isTTY) say("\n");
    else if (!input.isTTY) say(`${secret ? (v ? "****" : "") : v}\n`); // piped input isn't echoed
    return (v ?? "").trim();
  }
  return {
    async ask(prompt, def = "", opts = {}) {
      const v = await raw(prompt, opts.secret && def ? maskSecret(def) : def, opts);
      return v === "" ? def : v;
    },
    async confirm(prompt, def = false) {
      for (;;) {
        const v = (await raw(`${prompt} (y/n)`, def ? "Y" : "N")).toLowerCase();
        if (v === "") return def;
        if (["y", "yes"].includes(v)) return true;
        if (["n", "no"].includes(v)) return false;
      }
    },
    /** options: [{ label, value }]; answer by number. Returns the value. */
    async choose(prompt, options, defIndex = 0) {
      say(`  ${prompt}\n`);
      options.forEach((o, i) => say(`    ${i + 1}) ${o.label}${i === defIndex ? "  (default)" : ""}\n`));
      for (;;) {
        const v = await raw("choose", String(defIndex + 1));
        if (v === "") return options[defIndex].value;
        const n = Number(v);
        if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value;
      }
    },
    close() { rl?.close(); },
  };
}

// ── context + side-effect gates ────────────────────────────────────

function makeContext({ root, flags, prompter, out, env, fetchImpl, localEndpoints }) {
  const loaded = loadEnvBody(root);
  return {
    root, env, fetchImpl, localEndpoints, p: prompter, out,
    dryRun: flags.dryRun, yes: flags.yes,
    // A root override is a sandbox: nothing outside it (home, services, server) is changed.
    sandboxed: resolve(root) !== REPO,
    envFile: { path: loaded.envPath, original: loaded.existed ? loaded.before : "", body: loaded.after, existed: loaded.existed },
    files: new Map(), // other merged env files: path → { original, body }
    planned: [], // commands not executed (dry-run / sandbox)
    llmResults: [],
  };
}

const say = (ctx, s = "") => ctx.out(s);

/** Merge updates into the root .env; print the masked diff; write unless dry-run. */
function commitEnv(ctx, updates) {
  const next = mergeEnv(ctx.envFile.body, updates);
  const diff = envDiff(ctx.envFile.body, next);
  if (diff.length === 0) return say(ctx, "  .env: no changes");
  diff.forEach((l) => say(ctx, `  .env ${l}`));
  ctx.envFile.body = next;
  if (!ctx.dryRun) writeEnvFile(ctx.envFile.path, next);
}

/** Run a command, or record it when dry-run / sandboxed (unless `local`, i.e. confined to root). */
function runCmd(ctx, cmd, args, { cwd, local = false } = {}) {
  const shown = [cmd, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  if (ctx.dryRun || (ctx.sandboxed && !local)) {
    ctx.planned.push(shown);
    say(ctx, `  would run: ${shown}`);
    return true;
  }
  say(ctx, `  $ ${shown}`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: IS_WIN });
  if (r.status !== 0) say(ctx, `  !! exited ${r.status ?? r.error?.message}`);
  return r.status === 0;
}

/** Copy a file into the user's home, gated like runCmd. */
function copyIntoHome(ctx, src, dest) {
  if (ctx.dryRun || ctx.sandboxed) {
    ctx.planned.push(`copy ${src} -> ${dest}`);
    return say(ctx, `  would copy ${src} -> ${dest}`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  say(ctx, `  copied -> ${dest}`);
}

// ── step 1: memory/background AI routing ───────────────────────────

const PURPOSE_INFO = {
  brain: "memory triage, metadata extraction, thought links — highest volume. A local 7–8B instruct model (qwen2.5:7b-instruct, llama3.1:8b, qwen3:8b) is fine and saves the most subscription.",
  validator: "decides if a session met its acceptance criteria. Keep on Claude unless you have a 30B+ or strong hosted model (weak models give confident wrong verdicts).",
  responder: "auto-answers agent questions within 15s. Claude recommended; a local model must be warm (cold loads can miss the window).",
  vision: "OCR + captions for images. Needs a vision (VL) model such as qwen2.5vl:7b or llava:7b, or keep Claude, or turn it off.",
};

function describeChoice(c) {
  if (c.kind === "claude") return "Claude subscription";
  if (c.kind === "off") return "off";
  return `${c.model} @ ${c.baseUrl}${c.apiKey ? ` (key ${maskSecret(c.apiKey)})` : ""}`;
}

async function pickLocal(ctx, purpose, cur) {
  say(ctx, "  probing Ollama (:11434) and LM Studio (:1234)…");
  const found = await detectLocalEndpoints(ctx.localEndpoints, { fetchImpl: ctx.fetchImpl });
  const opts = found.map((e) => ({ label: `${e.name} ${e.baseUrl} (${e.models.length} model${e.models.length === 1 ? "" : "s"})`, value: e }));
  if (found.length === 0) {
    say(ctx, "  No local server answered. Install Ollama (https://ollama.com) and run `ollama pull qwen2.5:7b-instruct`,");
    say(ctx, "  or start LM Studio's local server. You can also type any OpenAI-compatible URL (llama.cpp, vLLM).");
  }
  opts.push({ label: "Enter a URL", value: "url" }, { label: "Cancel (keep current)", value: null });
  const def = Math.max(0, found.findIndex((e) => e.baseUrl === cur.baseUrl));
  let ep = await ctx.p.choose("Which local endpoint?", opts, found.length ? def : opts.length - 1);
  if (ep === null) return null;
  if (ep === "url") {
    const baseUrl = await ctx.p.ask("Base URL (ends in /v1)", cur.baseUrl || OLLAMA_URL);
    const again = await detectLocalEndpoints([{ name: "custom", baseUrl }], { fetchImpl: ctx.fetchImpl, timeoutMs: 5000 });
    ep = again[0] ?? { name: "custom", baseUrl, models: [] };
  }
  return { baseUrl: ep.baseUrl, model: await pickModel(ctx, purpose, ep.models, cur.model) };
}

async function pickModel(ctx, purpose, models, curModel) {
  if (models.length === 0) return ctx.p.ask("Model name", curModel || (purpose === "vision" ? "qwen2.5vl:7b" : "qwen2.5:7b-instruct"));
  const ranked = purpose === "vision"
    ? [...models.filter(isVisionModel), ...models.filter((m) => !isVisionModel(m))]
    : [...models.filter((m) => !isVisionModel(m))];
  if (purpose === "vision" && !models.some(isVisionModel)) {
    say(ctx, "  None of these looks vision-capable (VL). Pull one, e.g. `ollama pull qwen2.5vl:7b`, or keep Claude/off.");
  }
  const list = ranked.length ? ranked : models;
  let def = list.indexOf(curModel);
  if (def === -1) def = Math.max(0, list.findIndex((m) => /\b(7|8)b\b/i.test(m)));
  const opts = list.map((m) => ({ label: `${m}${isVisionModel(m) ? "  [vision]" : ""}`, value: m }));
  opts.push({ label: "Type a model name", value: "" });
  const picked = await ctx.p.choose("Which model?", opts, def);
  return picked || ctx.p.ask("Model name", curModel);
}

async function pickHosted(ctx, purpose, cur, session) {
  const baseUrl = await ctx.p.ask("Base URL", cur.kind === "hosted" ? cur.baseUrl : session.hostedUrl || OPENROUTER_URL);
  const known = cur.kind === "hosted" && cur.baseUrl === baseUrl ? cur.apiKey : session.keys.get(baseUrl) ?? "";
  const apiKey = await ctx.p.ask(known ? "API key (blank keeps the current one)" : "API key (stored only in .env)", known, { secret: true });
  const model = await ctx.p.ask("Model id", cur.kind === "hosted" ? cur.model : purpose === "vision" ? "" : "openai/gpt-5-mini");
  if (!model) return null;
  session.hostedUrl = baseUrl;
  if (apiKey) session.keys.set(baseUrl, apiKey);
  return { baseUrl, apiKey, model };
}

/** Test the endpoint once per (url, model, key); on failure offer to keep Claude. */
async function verifyChoice(ctx, purpose, choice, session) {
  const id = `${choice.baseUrl}|${choice.model}|${choice.apiKey ?? ""}`;
  if (!session.tests.has(id)) {
    say(ctx, `  testing ${choice.model} @ ${choice.baseUrl} (first call to a local model can take ~10–40s)…`);
    session.tests.set(id, await testChatCompletion({ ...choice, fetchImpl: ctx.fetchImpl }));
  }
  const t = session.tests.get(id);
  ctx.llmResults.push({ purpose, model: choice.model, baseUrl: choice.baseUrl, ...t });
  if (t.ok) {
    say(ctx, `  OK: ${t.latencyMs} ms, JSON came back: ${t.json ? "yes" : "NO"}`);
    if (!t.json) say(ctx, "  The model answered with prose — callers will skip items it can't parse. Prefer a 7B+ instruct model.");
    if (purpose === "responder" && t.latencyMs > 8000) {
      say(ctx, "  That is close to the responder's 15s window; setting NOSLEEP_LLM_TIMEOUT_MS_RESPONDER=45000.");
      choice.timeoutMs = "45000";
    }
    if (t.json) return choice;
  } else {
    say(ctx, `  FAILED after ${t.latencyMs} ms: ${t.error}${t.hint ? ` — ${t.hint}` : ""}`);
    say(ctx, "  With this config the server would skip or null these calls until the endpoint works.");
  }
  return (await ctx.p.confirm(`Keep Claude for ${purpose} instead?`, true)) ? { kind: "claude" } : choice;
}

export async function stepLlm(ctx) {
  const env = parseEnv(ctx.envFile.body);
  const routing = serverRouting(env);
  say(ctx, routing.line ? `  now: ${routing.line}` : `  now: ${PURPOSES.map((p) => `${p}=${describeChoice(currentLlmChoice(env, p))}`).join(", ")}`);
  const session = { tests: new Map(), keys: new Map(), hostedUrl: "" };
  const updates = {};
  for (const purpose of PURPOSES) {
    const cur = currentLlmChoice(env, purpose);
    say(ctx, `\n  ${purpose}: ${PURPOSE_INFO[purpose]}`);
    say(ctx, `  current: ${describeChoice(cur)}`);
    const opts = [
      { label: "Claude subscription", value: "claude" },
      { label: "Local OpenAI-compatible (Ollama / LM Studio / llama.cpp)", value: "local" },
      { label: "OpenRouter or another hosted OpenAI-compatible API", value: "hosted" },
      ...(purpose === "vision" ? [{ label: "Off (no OCR / captions)", value: "off" }] : []),
    ];
    const kind = await ctx.p.choose(`Route ${purpose} to`, opts, opts.findIndex((o) => o.value === cur.kind));
    if (kind === cur.kind && (kind === "claude" || kind === "off")) continue;
    let choice = { kind };
    if (kind === "local" || kind === "hosted") {
      const picked = kind === "local" ? await pickLocal(ctx, purpose, cur) : await pickHosted(ctx, purpose, cur, session);
      if (!picked || !picked.model) { say(ctx, "  unchanged"); continue; }
      choice = await verifyChoice(ctx, purpose, { kind, ...picked }, session);
      if (choice.kind !== "claude") {
        const fb = await ctx.p.confirm(`If ${purpose}'s endpoint fails, retry on Claude (spends subscription)?`, env[`NOSLEEP_LLM_FALLBACK_${purpose.toUpperCase()}`] === "claude");
        choice.fallback = fb ? "claude" : null;
      }
    }
    Object.assign(updates, llmUpdates(env, purpose, choice));
  }
  commitEnv(ctx, updates);
  const after = serverRouting(parseEnv(ctx.envFile.body));
  if (after.error) say(ctx, `  !! the server would refuse to start: ${after.error}`);
  else if (after.line) say(ctx, `  server will log: ${after.line}`);
  say(ctx, "  Restart the server for routing changes to apply.");
}

// ── step 2: brain ──────────────────────────────────────────────────

export async function stepBrain(ctx) {
  const env = parseEnv(ctx.envFile.body);
  say(ctx, "  Triage reads finished sessions and keeps what is worth remembering (auto-thoughts).");
  say(ctx, "  It runs on the `brain` route above; off = no automatic memories, manual capture still works.");
  const triageOn = env.NOSLEEP_BRAIN_DISABLE_TRIAGE !== "1";
  const on = await ctx.p.confirm("Auto-thought triage on?", triageOn);
  say(ctx, "  The nightly consolidator archives stale, never-recalled thoughts. dry-run logs what it would archive.");
  const modes = ["on", "dry-run", "off"];
  const curMode = modes.includes((env.NOSLEEP_BRAIN_CONSOLIDATE ?? "").toLowerCase()) ? env.NOSLEEP_BRAIN_CONSOLIDATE.toLowerCase() : "on";
  const mode = await ctx.p.choose("Consolidator mode", modes.map((m) => ({ label: m, value: m })), modes.indexOf(curMode));
  const updates = {};
  if (on !== triageOn) updates.NOSLEEP_BRAIN_DISABLE_TRIAGE = on ? null : "1";
  if (mode !== curMode || ("NOSLEEP_BRAIN_CONSOLIDATE" in env && env.NOSLEEP_BRAIN_CONSOLIDATE !== mode)) {
    updates.NOSLEEP_BRAIN_CONSOLIDATE = mode;
  }
  commitEnv(ctx, updates);
}

// ── step 3: NotebookLM research ────────────────────────────────────

/** First python >= 3.11 on PATH: { cmd, pre, version } or null. */
export function findPython() {
  const cands = IS_WIN
    ? [["py", ["-3"]], ["python", []], ["python3", []]]
    : [["python3.12", []], ["python3.11", []], ["python3.13", []], ["python3", []], ["python", []]];
  for (const [cmd, pre] of cands) {
    const r = spawnSync(cmd, [...pre, "-c", "import sys;print('%d.%d' % sys.version_info[:2])"], { encoding: "utf8", timeout: 10_000 });
    if (r.status !== 0) continue;
    const [maj, min] = r.stdout.trim().split(".").map(Number);
    if (maj === 3 && min >= 11) return { cmd, pre, version: r.stdout.trim() };
  }
  return null;
}

const headlessLinux = (env) => platform() === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY;

export async function stepResearch(ctx) {
  const pkg = join(ctx.root, "packages", "mcp-research");
  const venv = join(pkg, ".venv");
  const py = venvPython(venv);
  const installed = existsSync(py);
  say(ctx, "  NotebookLM research gives sessions research_* MCP tools answered by Google's NotebookLM,");
  say(ctx, "  saving Claude tokens on doc lookups. Needs Python 3.11+, a Google account, and a desktop");
  say(ctx, "  browser once for login. It is a separate stdio MCP server; the NoSleep server does not launch it.");
  const on = await ctx.p.choose("NotebookLM research", [{ label: "off", value: false }, { label: "on", value: true }], installed ? 1 : 0);
  if (!on) {
    if (installed) say(ctx, `  Leaving ${venv} in place (delete it and remove the MCP entry to uninstall).`);
    return;
  }
  if (!existsSync(join(pkg, "pyproject.toml"))) return say(ctx, `  !! ${pkg} has no pyproject.toml — nothing to install here.`);
  const python = findPython();
  if (!python && !installed) {
    return say(ctx, "  !! Python 3.11+ not found. Install it (python.org, brew install python@3.12, apt install python3.12-venv), then re-run.");
  }
  if (!installed) {
    say(ctx, `  using ${python.cmd} ${python.version}`);
    if (!runCmd(ctx, python.cmd, [...python.pre, "-m", "venv", venv], { local: true })) return;
  }
  if (await ctx.p.confirm(installed ? "Upgrade/reinstall the Python packages?" : "Install the Python packages + Chromium now (~300 MB)?", !installed && !ctx.yes)) {
    if (!runCmd(ctx, py, ["-m", "pip", "install", "-e", pkg], { cwd: pkg, local: true })) return;
    if (!runCmd(ctx, py, ["-m", "playwright", "install", "chromium"], { local: true })) {
      runCmd(ctx, py, ["-m", "pip", "install", "playwright"], { local: true });
      runCmd(ctx, py, ["-m", "playwright", "install", "chromium"], { local: true });
    }
  }
  const auth = notebookAuthPath(ctx.env);
  const loggedIn = existsSync(auth);
  say(ctx, loggedIn ? `  Google login found: ${auth}` : "  Not logged in yet.");
  if (headlessLinux(ctx.env)) {
    say(ctx, "  This looks like a headless Linux box (no DISPLAY): the login needs a visible browser.");
    say(ctx, "  Log in on a desktop machine, then copy ~/.notebooklm/storage_state.json here (or set NOTEBOOKLM_AUTH_JSON).");
  } else if (await ctx.p.confirm("Open a browser now to sign in to NotebookLM?", !loggedIn && !ctx.yes)) {
    runCmd(ctx, py, ["-m", "nosleep_research.auth"], { cwd: pkg });
  }
  const bin = IS_WIN ? join(venv, "Scripts", "nosleep-research.exe") : join(venv, "bin", "nosleep-research");
  const db = join(ctx.root, "data", "nosleep.db");
  say(ctx, "\n  Register it with Claude Code (NOSLEEP_DB_PATH = the server DB so the dashboard shows research savings):");
  const args = ["mcp", "add", "--scope", "user", "research", "-e", "NOSLEEP_ORG_ID=org_personal", "-e", `NOSLEEP_DB_PATH=${db}`, "--", bin];
  say(ctx, `    claude ${args.join(" ")}`);
  say(ctx, "  or in an MCP JSON config:");
  say(ctx, `    { "mcpServers": { "research": { "command": ${JSON.stringify(bin)}, "env": { "NOSLEEP_ORG_ID": "org_personal", "NOSLEEP_DB_PATH": ${JSON.stringify(db)} } } } }`);
  const claude = which("claude");
  if (claude && await ctx.p.confirm("Run that claude mcp add now?", false)) runCmd(ctx, claude, args, { cwd: tmpdir() });
}

// ── step 4: Claude Code / OpenCode integration ─────────────────────

/** Is an MCP server registered for Claude Code? Checked from a neutral cwd so a
 *  project .mcp.json doesn't count. Returns the scope line or null. */
function claudeMcpScope(claude, name) {
  const r = spawnSync(claude, ["mcp", "get", name], { cwd: tmpdir(), encoding: "utf8", timeout: 30_000, shell: IS_WIN });
  if (r.status !== 0) return null;
  return /Scope:\s*(.+)/.exec(r.stdout)?.[1]?.trim() ?? "registered";
}

export function skillFiles(home = homedir()) {
  const dest = join(home, ".claude");
  const cmds = join(REPO, "packages", "cli", "commands");
  const files = [
    [join(REPO, "packages", "cli", "skills", "nosleep-init", "SKILL.md"), join(dest, "skills", "nosleep-init", "SKILL.md")],
    [join(REPO, "packages", "auto-capture-skill", "SKILL.md"), join(dest, "skills", "auto-capture", "SKILL.md")],
  ];
  for (const f of ["nosleep-connect.md", "nosleep-go.md", "nosleep-pause.md", "nosleep-status.md"]) {
    if (existsSync(join(cmds, f))) files.push([join(cmds, f), join(dest, "commands", f)]);
  }
  return files.filter(([src]) => existsSync(src));
}

const sameFile = (a, b) => existsSync(b) && readFileSync(a).equals(readFileSync(b));

export async function stepClaude(ctx) {
  const port = Number(parseEnv(ctx.envFile.body).PORT) || SERVER_PORT;
  const claude = which("claude");
  if (!claude) {
    say(ctx, "  `claude` not on PATH. Install Claude Code (https://claude.com/claude-code), run `claude` once, then re-run this step.");
  } else {
    const scope = claudeMcpScope(claude, "nosleep");
    say(ctx, scope ? `  nosleep MCP already registered (${scope})` : "  nosleep MCP is not registered for Claude Code.");
    if (!scope && await ctx.p.confirm("Register it for every project (user scope)?", true)) {
      runCmd(ctx, claude, ["mcp", "add", "--scope", "user", "--transport", "http", "nosleep", `http://localhost:${port}/api/mcp`], { cwd: tmpdir() });
    }
  }
  const files = skillFiles();
  const stale = files.filter(([src, dest]) => !sameFile(src, dest));
  say(ctx, stale.length ? `  ${stale.length} of ${files.length} skills/commands missing or outdated in ~/.claude` : "  skills + slash commands up to date in ~/.claude");
  if (stale.length && await ctx.p.confirm("Copy /nosleep-init, auto-capture and /nosleep-* commands into ~/.claude?", true)) {
    for (const [src, dest] of stale) copyIntoHome(ctx, src, dest);
  }
  if (which("opencode")) {
    const plugin = join(REPO, "packages", "opencode-plugin", "nosleep.js");
    const dest = join(homedir(), ".config", "opencode", "plugins", "nosleep.js");
    say(ctx, "\n  OpenCode found. Per project: dashboard → Projects → Install hooks (targets claude + opencode).");
    say(ctx, "  Optional global plugin tracks OpenCode in every folder (docs/opencode.md).");
    if (existsSync(plugin) && !sameFile(plugin, dest) && await ctx.p.confirm("Install the global OpenCode plugin?", false)) {
      copyIntoHome(ctx, plugin, dest);
    }
  }
}

// ── step 5: mobile ─────────────────────────────────────────────────

function loadOtherEnv(ctx, path, examplePath) {
  if (!ctx.files.has(path)) {
    const existed = existsSync(path);
    const body = existed ? readFileSync(path, "utf8") : existsSync(examplePath) ? readFileSync(examplePath, "utf8") : "";
    ctx.files.set(path, { original: existed ? body : "", body });
  }
  return ctx.files.get(path);
}

function commitOther(ctx, path, updates, label) {
  const f = ctx.files.get(path);
  const next = mergeEnv(f.body, updates);
  const diff = envDiff(f.body, next);
  const exists = existsSync(path);
  if (diff.length === 0 && exists) return say(ctx, `  ${label}: no changes`);
  if (!exists) say(ctx, `  ${label}: ${ctx.dryRun ? "would create" : "creating"} from .env.example`);
  diff.forEach((l) => say(ctx, `  ${label} ${l}`));
  f.body = next;
  if (!ctx.dryRun) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, next); }
}

function javaMajor() {
  const r = spawnSync("java", ["-version"], { encoding: "utf8", timeout: 10_000, shell: IS_WIN });
  const m = /version "(\d+)(?:\.(\d+))?/.exec(`${r.stderr}${r.stdout}`);
  if (!m) return null;
  return m[1] === "1" ? Number(m[2]) : Number(m[1]);
}

function androidSdk(env) {
  const cands = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, join(homedir(), "Library", "Android", "sdk"),
    join(homedir(), "Android", "Sdk"), env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Android", "Sdk")];
  return cands.find((p) => p && existsSync(p)) ?? null;
}

export async function stepMobile(ctx) {
  const path = join(ctx.root, "packages", "mobile", ".env.local");
  const f = loadOtherEnv(ctx, path, join(REPO, "packages", "mobile", ".env.example"));
  const cur = parseEnv(f.body);
  say(ctx, `  Writes ${path} (gitignored). All optional for Expo Go; needed for your own device / EAS builds.`);
  const bundle = await ctx.p.ask("Bundle id (iOS bundle + Android package)", cur.NOSLEEP_BUNDLE_ID || "dev.nosleep.app");
  const team = await ctx.p.ask("Apple team id (blank = none)", cur.EXPO_APPLE_TEAM_ID || "");
  const eas = await ctx.p.ask("EAS project id from `npx eas init` (blank = none)", cur.EAS_PROJECT_ID || "");
  const owner = await ctx.p.ask("Expo account owner (blank = none)", cur.EXPO_OWNER || "");
  const port = Number(parseEnv(ctx.envFile.body).PORT) || SERVER_PORT;
  const cands = networkCandidates(undefined, port);
  const opts = [];
  if (cur.EXPO_PUBLIC_NOSLEEP_URL) opts.push({ label: `keep ${cur.EXPO_PUBLIC_NOSLEEP_URL}`, value: cur.EXPO_PUBLIC_NOSLEEP_URL });
  for (const c of cands) {
    if (c.url === cur.EXPO_PUBLIC_NOSLEEP_URL) continue;
    opts.push({ label: `${c.url}  (${c.kind === "tailscale" ? "Tailscale — works away from home" : `LAN ${c.iface}`})`, value: c.url });
  }
  opts.push({ label: "none — rely on LAN discovery / type it in the app", value: "" }, { label: "custom URL", value: "custom" });
  let url = await ctx.p.choose("Server URL the app tries first (EXPO_PUBLIC_NOSLEEP_URL)", opts, 0);
  if (url === "custom") url = await ctx.p.ask("URL", `http://<host>:${port}`);
  const wanted = { NOSLEEP_BUNDLE_ID: bundle, EXPO_APPLE_TEAM_ID: team, EAS_PROJECT_ID: eas, EXPO_OWNER: owner, EXPO_PUBLIC_NOSLEEP_URL: url };
  // Don't add empty KEY= lines for values that were never set.
  const updates = Object.fromEntries(Object.entries(wanted).filter(([k, v]) => v !== "" || k in cur));
  commitOther(ctx, path, updates, "mobile/.env.local");

  const mac = platform() === "darwin";
  const xcode = mac && spawnSync("xcodebuild", ["-version"], { encoding: "utf8", timeout: 15_000 }).status === 0;
  const sdk = androidSdk(ctx.env);
  const java = javaMajor();
  say(ctx, "\n  Build (from packages/mobile):");
  say(ctx, "    Expo Go, any OS:        npx expo start              (scan QR; no voice, push unreliable)");
  say(ctx, `    iOS release:            npx expo prebuild --clean && npx expo run:ios --configuration Release --device`);
  say(ctx, `                            ${xcode ? "ready (macOS + Xcode found)" : mac ? "needs Xcode (App Store) + `xcode-select --install`" : "needs macOS + Xcode — use EAS from this OS"}${team ? "" : "; set an Apple team id for device signing"}`);
  say(ctx, "    Android release:        npx expo run:android --variant release");
  say(ctx, `                            ${sdk ? `SDK ${sdk}` : "needs Android Studio / SDK (ANDROID_HOME)"}, ${java === 17 ? "JDK 17 found" : `needs JDK 17 (found ${java ?? "none"})`}`);
  say(ctx, `    EAS cloud, any OS:      npx eas init, then npx eas build --profile preview --platform ios|android${eas ? "" : "  (set the EAS project id)"}`);
  say(ctx, "  EXPO_PUBLIC_NOSLEEP_URL is inlined at bundle time: restart Metro with `npx expo start -c` after changing it.");
}

// ── step 6: autostart ──────────────────────────────────────────────

export async function stepService(ctx) {
  let services = [];
  try {
    services = renderServices({ os: platform(), repo: REPO, home: homedir(), nodeBin: process.execPath, claudeBin: null });
  } catch (err) {
    return say(ctx, `  ${err.message}`);
  }
  const installed = services.every((s) => existsSync(s.path));
  say(ctx, installed ? "  Autostart is installed (re-installing refreshes node/claude paths)." : "  Autostart is not installed.");
  if (!(await ctx.p.confirm(installed ? "Re-install autostart services?" : "Install autostart (server + dashboard at login)?", false))) return;
  if (ctx.sandboxed) {
    ctx.planned.push("node scripts/install.mjs --service");
    return say(ctx, "  would run: node scripts/install.mjs --service  (root override: not touching services)");
  }
  installService({ dryRun: ctx.dryRun, claudeBin: which("claude") });
}

// ── step 7: doctor (+ optional start) ──────────────────────────────

function startServer(ctx) {
  const os = platform();
  const svc = (() => { try { return renderServices({ os, repo: REPO, home: homedir(), nodeBin: process.execPath, claudeBin: null }); } catch { return []; } })();
  if (os === "darwin" && svc[0] && existsSync(svc[0].path)) return runCmd(ctx, "launchctl", ["kickstart", "-k", `gui/${process.getuid()}/com.nosleep.server`]);
  if (os === "linux" && svc[0] && existsSync(svc[0].path)) return runCmd(ctx, "systemctl", ["--user", "start", "nosleep-server.service"]);
  const logDir = join(homedir(), ".nosleep");
  mkdirSync(logDir, { recursive: true });
  const fd = openSync(join(logDir, "server.log"), "a");
  spawn(process.execPath, [join(REPO, "node_modules", "tsx", "dist", "cli.mjs"), join(REPO, "packages", "server", "src", "server.ts")],
    { cwd: REPO, detached: true, stdio: ["ignore", fd, fd] }).unref();
  say(ctx, `  started in the background; log: ${join(logDir, "server.log")}`);
}

export async function stepDoctor(ctx) {
  if (ctx.dryRun) say(ctx, "  (dry run: checks read the files on disk, not the planned changes)");
  const r = await runDoctor({ root: ctx.root, out: (s) => say(ctx, `  ${s}`), env: ctx.env, fetchImpl: ctx.fetchImpl });
  const server = r.checks.find((c) => c.name === "server");
  if (server?.status !== "ok" && !ctx.sandboxed && !ctx.dryRun && await ctx.p.confirm("Start the NoSleep server now?", false)) startServer(ctx);
  return r;
}

// ── driver ─────────────────────────────────────────────────────────

const STEPS = {
  llm: ["Memory / background AI routing", stepLlm],
  brain: ["Brain: triage + consolidator", stepBrain],
  research: ["Research (NotebookLM)", stepResearch],
  claude: ["Claude Code / OpenCode integration", stepClaude],
  mobile: ["Mobile app build config", stepMobile],
  service: ["Autostart", stepService],
  doctor: ["Verify (doctor)", stepDoctor],
};

export function parseFlags(argv, env = process.env) {
  const val = (name) => { const i = argv.indexOf(name); return i !== -1 ? argv[i + 1] : undefined; };
  const steps = (val("--steps") ?? STEP_IDS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = steps.filter((s) => !STEP_IDS.includes(s));
  if (unknown.length) throw new Error(`unknown step(s): ${unknown.join(", ")} (valid: ${STEP_IDS.join(", ")})`);
  return {
    yes: argv.includes("--yes") || argv.includes("-y"),
    dryRun: argv.includes("--dry-run"),
    help: argv.includes("--help") || argv.includes("-h"),
    doctor: argv[0] === "doctor",
    root: rootFromArgs(argv, env),
    steps,
  };
}

export async function runSetup({ argv = [], env = process.env, out = (s) => process.stdout.write(`${s}\n`),
  prompter, fetchImpl = fetch, localEndpoints = LOCAL_ENDPOINTS } = {}) {
  const flags = parseFlags(argv, env);
  if (flags.doctor) {
    const r = await runDoctor({ root: flags.root, out, env, fetchImpl, llmTest: !argv.includes("--no-llm-test") });
    return { exitCode: r.failed ? 1 : 0 };
  }
  const p = prompter ?? createPrompter({ yes: flags.yes });
  const ctx = makeContext({ root: flags.root, flags, prompter: p, out, env, fetchImpl, localEndpoints });
  out(`NoSleep setup — root ${ctx.root}${ctx.dryRun ? "  [DRY RUN: nothing is written]" : ""}${ctx.sandboxed ? "  [root override: home/services/server untouched]" : ""}`);
  if (!existsSync(join(REPO, "node_modules"))) out("!! dependencies not installed — run `node scripts/install.mjs` first for routing validation + doctor.");
  if (!ctx.envFile.existed || ctx.envFile.original !== ctx.envFile.body) {
    out(ctx.envFile.existed
      ? `  .env: ${ctx.dryRun ? "would generate" : "generating"} blank NOSLEEP_API_KEY / NOSLEEP_HOOK_SECRET`
      : `  .env not found: ${ctx.dryRun ? "would create" : "creating"} it from .env.example with a fresh API key + hook secret`);
    if (!ctx.dryRun) writeEnvFile(ctx.envFile.path, ctx.envFile.body);
  }
  let doctor = null;
  try {
    for (const [i, id] of flags.steps.entries()) {
      const [title, fn] = STEPS[id];
      out(`\n── ${i + 1}/${flags.steps.length} ${title} ──`);
      if (id !== "doctor" && !(await p.confirm(`Configure ${title.toLowerCase()}?`, true))) { out("  skipped"); continue; }
      const r = await fn(ctx);
      if (id === "doctor") doctor = r;
    }
  } finally {
    p.close?.();
  }
  if (ctx.dryRun) {
    out("\nPlanned changes (dry run — nothing was written):");
    const envLines = envDiff(ctx.envFile.original, ctx.envFile.body);
    out(`  ${ctx.envFile.path}${envLines.length ? "" : ": no changes"}`);
    envLines.forEach((l) => out(`    ${l}`));
    for (const [path, f] of ctx.files) {
      const lines = envDiff(f.original, f.body);
      out(`  ${path}${lines.length ? "" : ": no changes"}`);
      lines.forEach((l) => out(`    ${l}`));
    }
    ctx.planned.forEach((c) => out(`  would run: ${c}`));
  }
  out("\nDone. Re-run any time: npm run setup (or --steps <ids>). Health: npm run doctor.");
  return { exitCode: !ctx.dryRun && doctor?.failed ? 1 : 0, ctx };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0] + "*/\n");
  } else {
    runSetup({ argv })
      .then((r) => { process.exitCode = r.exitCode; })
      .catch((err) => { process.stderr.write(`setup failed: ${err.message}\n`); process.exit(2); });
  }
}
