#!/usr/bin/env node
/**
 * NoSleep installer — one entrypoint for macOS, Linux and Windows.
 *
 *   node scripts/install.mjs              # deps + .env + data dir (safe to re-run)
 *   node scripts/install.mjs --service    # ...and autostart server + dashboard at login
 *   node scripts/install.mjs --uninstall-service
 *   node scripts/install.mjs --dry-run --service   # print what would be written
 *   flags: --skip-deps (no npm install), --skip-models (no embedding model download)
 *
 * Autostart backends: macOS LaunchAgents (+ watchdog), Linux systemd --user
 * units, Windows Task Scheduler (experimental; WSL2 is the tested path).
 * Uses only Node built-ins so it runs before `npm install`.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MIN_NODE_MAJOR = 22;
export const SERVER_PORT = 3777;
const WEB_PORT = 5173;

// ── pure helpers (unit-tested) ─────────────────────────────────────

/** Fill blank NOSLEEP_API_KEY / NOSLEEP_HOOK_SECRET in an .env body; keep everything else. */
export function fillEnv(body, gen = () => randomBytes(32).toString("hex")) {
  const lines = body.split("\n").map((line) => {
    const m = /^(NOSLEEP_API_KEY|NOSLEEP_HOOK_SECRET)=\s*$/.exec(line);
    return m ? `${m[1]}=${gen()}` : line;
  });
  return lines.join("\n");
}

export function readEnvValue(body, key) {
  return parseEnv(body)[key] ?? "";
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ACTIVE_LINE = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

function unquote(raw) {
  const v = raw.trim();
  const q = v[0];
  if ((q === '"' || q === "'") && v.length > 1) {
    const end = v.indexOf(q, 1);
    if (end > 0) return v.slice(1, end);
  }
  return v.replace(/\s+#.*$/, "").trim(); // unquoted: drop inline " # comment"
}

/** Active KEY=value assignments of an .env body (dotenv semantics: comments
 *  ignored, quotes stripped, inline " # comment" dropped, last one wins). */
export function parseEnv(body) {
  const out = {};
  for (const line of body.split(/\r?\n/)) {
    const m = ACTIVE_LINE.exec(line);
    if (m) out[m[2]] = unquote(m[3]);
  }
  return out;
}

function formatEnvValue(key, value) {
  const v = String(value);
  if (/[\r\n]/.test(v)) throw new Error(`${key}: multi-line values are not supported`);
  if (v === "" || /^[^\s#"'`$\\]+$/.test(v)) return v;
  if (!v.includes('"')) return `"${v}"`;
  if (!v.includes("'")) return `'${v}'`;
  throw new Error(`${key}: value contains both quote characters`);
}

/**
 * Merge `updates` into an .env body without touching any other line.
 *   { KEY: "v" }  → replace the active KEY= line in place (dropping later
 *                   duplicates so the result is unambiguous), else append.
 *   { KEY: null } → remove the active KEY= line(s); comments stay.
 * Commented-out examples (`# KEY=`) are never modified. Pure.
 */
export function mergeEnv(body, updates) {
  for (const key of Object.keys(updates)) {
    if (!ENV_KEY.test(key)) throw new Error(`invalid .env key: ${JSON.stringify(key)}`);
  }
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const seen = new Set();
  const lines = [];
  for (const line of body.split(/\r?\n/)) {
    const m = ACTIVE_LINE.exec(line);
    const key = m?.[2];
    if (!m || !Object.prototype.hasOwnProperty.call(updates, key)) { lines.push(line); continue; }
    if (seen.has(key)) continue;
    seen.add(key);
    const value = updates[key];
    if (value === null || value === undefined) continue;
    lines.push(`${m[1] ?? ""}${key}=${formatEnvValue(key, value)}`);
  }
  const appended = Object.entries(updates)
    .filter(([k, v]) => !seen.has(k) && v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${formatEnvValue(k, v)}`);
  if (appended.length === 0) return lines.join(eol);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return [...lines, ...appended, ""].join(eol);
}

/** Directories that must be on the service PATH: node, the claude CLI, common bins. */
export function servicePath({ nodeBin, claudeBin, home, os }) {
  const dirs = [dirname(nodeBin)];
  if (claudeBin) dirs.push(dirname(claudeBin));
  if (os === "win32") return [...new Set(dirs)].join(";");
  dirs.push(join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin");
  return [...new Set(dirs)].join(":");
}

const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function plist({ label, args, cwd, env, logOut, logErr, extra = "" }) {
  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
${cwd ? `  <key>WorkingDirectory</key><string>${xml(cwd)}</string>\n` : ""}  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key><true/>
${extra}  <key>StandardOutPath</key><string>${xml(logOut)}</string>
  <key>StandardErrorPath</key><string>${xml(logErr)}</string>
</dict>
</plist>
`;
}

/** Render every service definition for `os`. Returns [{ name, path, content }]. */
export function renderServices({ os, repo, home, nodeBin, claudeBin }) {
  const tsx = join(repo, "node_modules", "tsx", "dist", "cli.mjs");
  const vite = join(repo, "node_modules", "vite", "bin", "vite.js");
  const server = join(repo, "packages", "server", "src", "server.ts");
  const web = join(repo, "packages", "web");
  const PATH = servicePath({ nodeBin, claudeBin, home, os });
  const logs = join(home, ".nosleep");

  if (os === "darwin") {
    const agents = join(home, "Library", "LaunchAgents");
    const keepAlive = "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n  <key>ThrottleInterval</key><integer>10</integer>\n";
    return [
      {
        name: "com.nosleep.server",
        path: join(agents, "com.nosleep.server.plist"),
        content: plist({
          label: "com.nosleep.server", args: [nodeBin, tsx, server], cwd: repo,
          env: { PATH, HOME: home, NODE_ENV: "production" },
          logOut: join(logs, "server.log"), logErr: join(logs, "server.err"), extra: keepAlive,
        }),
      },
      {
        name: "com.nosleep.web",
        path: join(agents, "com.nosleep.web.plist"),
        content: plist({
          label: "com.nosleep.web", args: [nodeBin, vite, "--host"], cwd: web,
          env: { PATH, HOME: home },
          logOut: join(logs, "web.log"), logErr: join(logs, "web.err"), extra: keepAlive,
        }),
      },
      {
        name: "com.nosleep.watchdog",
        path: join(agents, "com.nosleep.watchdog.plist"),
        content: plist({
          label: "com.nosleep.watchdog", args: [join(repo, "scripts", "watchdog.sh")],
          env: { PATH },
          logOut: join(home, "Library", "Logs", "nosleep-watchdog.log"),
          logErr: join(home, "Library", "Logs", "nosleep-watchdog.log"),
          extra: "  <key>StartInterval</key><integer>30</integer>\n",
        }),
      },
    ];
  }

  if (os === "linux") {
    const units = join(home, ".config", "systemd", "user");
    const unit = (desc, exec, cwd) => `[Unit]
Description=${desc}
After=network-online.target

[Service]
WorkingDirectory=${cwd}
ExecStart=${exec}
Environment=PATH=${PATH}
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
    return [
      { name: "nosleep-server.service", path: join(units, "nosleep-server.service"),
        content: unit("NoSleep server", `"${nodeBin}" "${tsx}" "${server}"`, repo) },
      { name: "nosleep-web.service", path: join(units, "nosleep-web.service"),
        content: unit("NoSleep web dashboard", `"${nodeBin}" "${vite}" --host`, web) },
    ];
  }

  if (os === "win32") {
    const dir = join(home, ".nosleep");
    const cmd = (exe, args, cwd, log) =>
      `@echo off\r\nset "PATH=${PATH};%PATH%"\r\ncd /d "${cwd}"\r\n"${exe}" ${args} >> "${log}" 2>&1\r\n`;
    return [
      { name: "NoSleepServer", path: join(dir, "nosleep-server.cmd"),
        content: cmd(nodeBin, `"${tsx}" "${server}"`, repo, join(dir, "server.log")) },
      { name: "NoSleepWeb", path: join(dir, "nosleep-web.cmd"),
        content: cmd(nodeBin, `"${vite}" --host`, web, join(dir, "web.log")) },
    ];
  }

  throw new Error(`Unsupported platform for autostart: ${os}`);
}

// ── side-effecting steps ───────────────────────────────────────────

const log = (msg) => process.stdout.write(`==> ${msg}\n`);
const warn = (msg) => process.stdout.write(`!!  ${msg}\n`);

export function which(bin) {
  const r = spawnSync(platform() === "win32" ? "where" : "which", [bin], { encoding: "utf8" });
  if (r.status === 0) return r.stdout.split(/\r?\n/)[0].trim();
  const local = join(homedir(), ".local", "bin", bin);
  return existsSync(local) ? local : null;
}

/** The node to bake into services: the PATH symlink (e.g. /opt/homebrew/bin/node)
 * when it is this same binary, so a versioned Cellar/nvm path doesn't rot. */
function stableNodeBin() {
  const onPath = which("node");
  try {
    if (onPath && realpathSync(onPath) === realpathSync(process.execPath)) return onPath;
  } catch { /* fall through */ }
  return process.execPath;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: platform() === "win32", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
}

function checkPrereqs() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE_MAJOR) {
    throw new Error(`Node ${MIN_NODE_MAJOR}+ required (found ${process.versions.node}). See .nvmrc.`);
  }
  const claude = which("claude");
  if (!claude) warn("`claude` CLI not found on PATH — install Claude Code and run `claude` once to log in.");
  if (!which("git")) warn("git not found — strategy/branch features expect it.");
  return claude;
}

/** The .env body for `root` as the installer would leave it: the existing
 *  file, or .env.example; blank auth keys generated either way. */
export function loadEnvBody(root = REPO) {
  const envPath = join(root, ".env");
  const existed = existsSync(envPath);
  const example = existsSync(join(root, ".env.example")) ? join(root, ".env.example") : join(REPO, ".env.example");
  const before = readFileSync(existed ? envPath : example, "utf8");
  return { envPath, existed, before, after: fillEnv(before) };
}

/** Write an .env body owner-only (0600), also tightening an existing file. */
export function writeEnvFile(path, body) {
  writeFileSync(path, body, { mode: 0o600 });
  if (platform() !== "win32") chmodSync(path, 0o600);
}

function ensureEnv(dryRun) {
  const { envPath, existed, before, after } = loadEnvBody(REPO);
  if (!dryRun && (after !== before || !existed)) writeEnvFile(envPath, after);
  log(existed ? (after === before ? ".env present (unchanged)" : ".env: generated missing keys") : "created .env with fresh API key + hook secret");
  if (!dryRun) mkdirSync(join(REPO, "data"), { recursive: true });
  return readEnvValue(after, "NOSLEEP_API_KEY");
}

// Semantic search model (packages/server/src/embeddings/embedder.ts reads data/models/).
// Quantized all-MiniLM-L6-v2, ~23MB; the server runs without it (no vector search).
const MODEL_BASE = "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/";
export const MODEL_FILES = [
  ["onnx/model_quantized.onnx", "minilm-l6-v2.onnx"],
  ["tokenizer.json", "tokenizer.json"],
  ["tokenizer_config.json", "tokenizer_config.json"],
];

async function ensureModels(dryRun) {
  const dir = join(REPO, "data", "models");
  const missing = MODEL_FILES.filter(([, local]) => !existsSync(join(dir, local)));
  if (missing.length === 0) return log("embedding model present");
  if (dryRun) return log(`would download ${missing.length} model file(s) to ${dir}`);
  mkdirSync(dir, { recursive: true });
  for (const [remote, local] of missing) {
    try {
      const res = await fetch(MODEL_BASE + remote, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(join(dir, local), Buffer.from(await res.arrayBuffer()));
      log(`downloaded ${local}`);
    } catch (err) {
      warn(`model download failed (${local}: ${err.message}) — semantic search stays off until data/models/ is filled; re-run the installer.`);
      return;
    }
  }
}

export function installService({ dryRun, claudeBin }) {
  const os = platform();
  const home = homedir();
  const services = renderServices({ os, repo: REPO, home, nodeBin: stableNodeBin(), claudeBin });
  for (const s of services) {
    if (dryRun) { log(`would write ${s.path}\n${s.content}`); continue; }
    mkdirSync(dirname(s.path), { recursive: true });
    writeFileSync(s.path, s.content);
    log(`wrote ${s.path}`);
  }
  if (dryRun) return;
  mkdirSync(join(home, ".nosleep"), { recursive: true });

  if (os === "darwin") {
    const uid = String(process.getuid());
    for (const s of services) {
      spawnSync("launchctl", ["bootout", `gui/${uid}/${s.name}`], { stdio: "ignore" });
      run("launchctl", ["bootstrap", `gui/${uid}`, s.path]);
    }
  } else if (os === "linux") {
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", "nosleep-server.service", "nosleep-web.service"]);
    log("tip: `loginctl enable-linger $USER` keeps NoSleep running when you're logged out");
  } else if (os === "win32") {
    for (const s of services) {
      run("schtasks", ["/Create", "/F", "/SC", "ONLOGON", "/TN", s.name, "/TR", `"${s.path}"`]);
      run("schtasks", ["/Run", "/TN", s.name]);
    }
    warn("Windows autostart is experimental — WSL2 is the tested path.");
  }
}

function uninstallService() {
  const os = platform();
  const services = renderServices({ os, repo: REPO, home: homedir(), nodeBin: process.execPath, claudeBin: null });
  for (const s of services) {
    if (os === "darwin") spawnSync("launchctl", ["bootout", `gui/${process.getuid()}/${s.name}`], { stdio: "ignore" });
    if (os === "linux") spawnSync("systemctl", ["--user", "disable", "--now", s.name], { stdio: "ignore" });
    if (os === "win32") spawnSync("schtasks", ["/Delete", "/F", "/TN", s.name], { stdio: "ignore", shell: true });
    rmSync(s.path, { force: true });
    log(`removed ${s.name}`);
  }
}

async function main(argv) {
  const flags = new Set(argv);
  const dryRun = flags.has("--dry-run");
  if (flags.has("--help") || flags.has("-h")) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0] + "*/\n");
    return;
  }
  if (flags.has("--uninstall-service")) return uninstallService();

  const claudeBin = checkPrereqs();
  if (!flags.has("--skip-deps") && !dryRun) {
    log("npm install (workspaces)…");
    run("npm", ["install"], { cwd: REPO });
  }
  const apiKey = ensureEnv(dryRun);
  if (!flags.has("--skip-models")) await ensureModels(dryRun);
  if (flags.has("--service")) installService({ dryRun, claudeBin });

  process.stdout.write(`
NoSleep is installed.

  Server     http://localhost:${SERVER_PORT}/health
  Dashboard  http://localhost:${WEB_PORT}
  API key    ${apiKey ? `${apiKey.slice(0, 8)}… (full value in .env → NOSLEEP_API_KEY)` : "(none — open dev mode)"}

${flags.has("--service") ? "Services autostart at login." : "Run it:  npm run dev:server   and   npm run dev:web   (or re-run with --service)"}
Next: open the dashboard, paste the API key in Settings, add a project. See README.md → "Get running".
`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`install failed: ${err.message}\n`);
    process.exit(1);
  });
}
