import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * OpenCode target of the NoSleep hooks installer (called from
 * hooks-installer.ts — not a separate install path).
 *
 * Writes into <project>/.opencode/:
 *   plugins/nosleep.js       the NoSleep plugin (packages/opencode-plugin/nosleep.js)
 *   nosleep.json             baked org / server URL / project path for the plugin
 *   commands/nosleep-*.md    the /nosleep-* commands, OpenCode frontmatter
 *   opencode.json            `mcp.nosleep` remote entry with the trusted org header
 *
 * The auto-capture skill (.opencode/skills/auto-capture/) is written by
 * hooks-installer.ts's writeBrainSkills — the same code path as the Claude
 * target — so there is one skill source for both CLIs.
 */

export interface OpenCodeInstallConfig {
  readonly serverPort: number;
  readonly orgId: string;
}

export const OPENCODE_PLUGIN_FILE = join(".opencode", "plugins", "nosleep.js");
const CONFIG_FILE = join(".opencode", "nosleep.json");
const COMMANDS_DIR = join(".opencode", "commands");
const SKILL_DIR = join(".opencode", "skills", "auto-capture");
const OPENCODE_JSON = join(".opencode", "opencode.json");
const COMMAND_PREFIX = "nosleep-";

/** Frontmatter keys OpenCode commands understand; Claude-only keys
 *  (allowed-tools, argument-hint) are dropped. */
const OPENCODE_COMMAND_KEYS = new Set(["description", "agent", "model", "subtask"]);

/** Both sibling packages sit four levels up from this file in src (tsx) —
 *  same resolution writeBrainSkills uses for auto-capture-skill. */
function packagesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..");
}

/** A project "uses OpenCode" when it already has OpenCode config. */
export function detectOpenCode(projectPath: string): boolean {
  return (
    existsSync(join(projectPath, ".opencode")) ||
    existsSync(join(projectPath, "opencode.json")) ||
    existsSync(join(projectPath, "opencode.jsonc"))
  );
}

export function isOpenCodeInstalled(projectPath: string): boolean {
  return existsSync(join(projectPath, OPENCODE_PLUGIN_FILE));
}

export function installOpenCodeHooks(projectPath: string, config: OpenCodeInstallConfig): void {
  const pluginSrc = join(packagesDir(), "opencode-plugin", "nosleep.js");
  if (!existsSync(pluginSrc)) {
    throw new Error(`NoSleep OpenCode plugin source not found at ${pluginSrc}`);
  }

  const pluginPath = join(projectPath, OPENCODE_PLUGIN_FILE);
  mkdirSync(dirname(pluginPath), { recursive: true });
  writeFileSync(pluginPath, readFileSync(pluginSrc, "utf-8"));

  writeFileSync(
    join(projectPath, CONFIG_FILE),
    JSON.stringify(
      { orgId: config.orgId, baseUrl: `http://localhost:${config.serverPort}`, projectPath },
      null,
      2,
    ),
  );

  writeOpenCodeCommands(projectPath);
  writeOpenCodeMcpConfig(projectPath, config);
}

export function uninstallOpenCodeHooks(projectPath: string): void {
  rmSync(join(projectPath, OPENCODE_PLUGIN_FILE), { force: true });
  rmSync(join(projectPath, CONFIG_FILE), { force: true });
  rmSync(join(projectPath, SKILL_DIR), { recursive: true, force: true });

  const commandsDir = join(projectPath, COMMANDS_DIR);
  if (existsSync(commandsDir)) {
    for (const name of shippedCommandNames()) rmSync(join(commandsDir, name), { force: true });
  }

  const jsonPath = join(projectPath, OPENCODE_JSON);
  const json = readJsonObject(jsonPath);
  const mcp = json?.mcp as Record<string, unknown> | undefined;
  if (json && mcp && "nosleep" in mcp) {
    const { nosleep: _removed, ...rest } = mcp;
    writeFileSync(jsonPath, JSON.stringify({ ...json, mcp: rest }, null, 2));
  }
}

// ── Internal ────────────────────────────────────────────

function shippedCommandNames(): string[] {
  const dir = join(packagesDir(), "cli", "commands");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith(COMMAND_PREFIX) && f.endsWith(".md"));
}

function writeOpenCodeCommands(projectPath: string): void {
  const srcDir = join(packagesDir(), "cli", "commands");
  const names = shippedCommandNames();
  if (names.length === 0) return; // commands package missing — non-fatal, hooks still work
  const outDir = join(projectPath, COMMANDS_DIR);
  mkdirSync(outDir, { recursive: true });
  for (const name of names) {
    const src = readFileSync(join(srcDir, name), "utf-8");
    writeFileSync(join(outDir, name), toOpenCodeCommand(src));
  }
}

/** Convert a Claude Code command file to OpenCode: keep the body ($ARGUMENTS
 *  is the same placeholder in both) and only the frontmatter keys OpenCode
 *  understands. */
export function toOpenCodeCommand(markdown: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (!match) return markdown;
  const kept = match[1]
    .split(/\r?\n/)
    .filter((line) => {
      const key = /^([A-Za-z0-9_-]+)\s*:/.exec(line)?.[1];
      return key !== undefined && OPENCODE_COMMAND_KEYS.has(key);
    });
  const body = markdown.slice(match[0].length);
  return `---\n${kept.join("\n")}\n---\n${body}`;
}

/** Merge the NoSleep remote MCP entry into .opencode/opencode.json, preserving
 *  everything else. An unparseable file (e.g. hand-written JSONC) is left
 *  untouched rather than clobbered. */
function writeOpenCodeMcpConfig(projectPath: string, config: OpenCodeInstallConfig): void {
  const jsonPath = join(projectPath, OPENCODE_JSON);
  const existing = existsSync(jsonPath) ? readJsonObject(jsonPath) : {};
  if (!existing) return;
  const mcp = (existing.mcp as Record<string, Record<string, unknown>> | undefined) ?? {};
  const prev = mcp.nosleep ?? {};
  const prevHeaders = (prev.headers as Record<string, string> | undefined) ?? {};
  const next = {
    $schema: "https://opencode.ai/config.json",
    ...existing,
    mcp: {
      ...mcp,
      nosleep: {
        ...prev,
        type: "remote",
        url: (prev.url as string | undefined) ?? `http://localhost:${config.serverPort}/api/mcp`,
        enabled: prev.enabled ?? true,
        headers: { ...prevHeaders, "x-nosleep-org": config.orgId },
      },
    },
  };
  writeFileSync(jsonPath, JSON.stringify(next, null, 2));
}

function readJsonObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
