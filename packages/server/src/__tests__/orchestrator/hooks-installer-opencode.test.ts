import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  installHooks,
  uninstallHooks,
  resolveHookTargets,
} from "../../orchestrator/hooks-installer.js";
import { toOpenCodeCommand } from "../../orchestrator/hooks-installer-opencode.js";

const tempDirs: string[] = [];
function tempProject(): string {
  const dir = join(tmpdir(), `nosleep-oc-test-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf-8"));

describe("installHooks — target resolution", () => {
  it("defaults to Claude only for a project without OpenCode config", () => {
    const project = tempProject();
    expect(resolveHookTargets(project)).toEqual(["claude"]);

    installHooks(project, { serverPort: 3777, orgId: "org_personal" });

    expect(existsSync(join(project, ".claude", "nosleep-hooks", "pre-tool.mjs"))).toBe(true);
    expect(existsSync(join(project, ".opencode"))).toBe(false); // no litter for non-OpenCode projects
  });

  it("auto-adds OpenCode when the project already uses it", () => {
    const project = tempProject();
    writeFileSync(join(project, "opencode.json"), "{}");
    expect(resolveHookTargets(project)).toEqual(["claude", "opencode"]);

    installHooks(project, { serverPort: 3777, orgId: "org_personal" });

    expect(existsSync(join(project, ".claude", "nosleep-hooks", "pre-tool.mjs"))).toBe(true);
    expect(existsSync(join(project, ".opencode", "plugins", "nosleep.js"))).toBe(true);
  });

  it("explicit targets win over detection (OpenCode only)", () => {
    const project = tempProject();

    installHooks(project, { serverPort: 3777, orgId: "org_work", targets: ["opencode"] });

    expect(existsSync(join(project, ".claude", "nosleep-hooks"))).toBe(false);
    expect(existsSync(join(project, ".claude", "settings.local.json"))).toBe(false);
    expect(existsSync(join(project, ".opencode", "plugins", "nosleep.js"))).toBe(true);
    // Auto-capture skill lands in OpenCode's native skills dir.
    const skill = readFileSync(join(project, ".opencode", "skills", "auto-capture", "SKILL.md"), "utf-8");
    expect(skill).toMatch(/^---\nname: auto-capture\n/);
    expect(skill).toMatch(/^description:/m);
  });
});

describe("installHooks — opencode target output", () => {
  it("writes plugin config with org, server URL and project path", () => {
    const project = tempProject();
    installHooks(project, { serverPort: 4100, orgId: "org_side", targets: ["opencode"] });

    expect(readJson(join(project, ".opencode", "nosleep.json"))).toEqual({
      orgId: "org_side",
      baseUrl: "http://localhost:4100",
      projectPath: project,
    });
  });

  it("installs a loadable plugin module that exports exactly one plugin function", async () => {
    const project = tempProject();
    installHooks(project, { serverPort: 3777, orgId: "org_personal", targets: ["opencode"] });

    const mod = await import(pathToFileURL(join(project, ".opencode", "plugins", "nosleep.js")).href);
    const exported = Object.values(mod).filter((v) => typeof v === "function");
    expect(exported).toHaveLength(1);
    // The installed copy finds its sibling nosleep.json and registers against the baked org/path.
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const hooks = await (exported[0] as (i: unknown) => Promise<Record<string, Function>>)({
      directory: project,
      worktree: project,
      env: {},
      fetch: async (url: string, init: { body: string }) => {
        calls.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({ success: true, data: { sessionId: "manual_x" } }), { status: 200 });
      },
    });
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "oc1", callID: "c" }, { args: { command: "ls" } });
    expect(calls[0].url).toBe("http://localhost:3777/api/sessions/register");
    expect(calls[0].body).toMatchObject({ orgId: "org_personal", projectPath: project, agent: "opencode" });
  });

  it("installs /nosleep-* commands with only OpenCode frontmatter keys", () => {
    const project = tempProject();
    installHooks(project, { serverPort: 3777, orgId: "org_personal", targets: ["opencode"] });

    const dir = join(project, ".opencode", "commands");
    const files = readdirSync(dir).sort();
    expect(files).toEqual(expect.arrayContaining(["nosleep-connect.md", "nosleep-go.md", "nosleep-pause.md", "nosleep-status.md"]));
    const go = readFileSync(join(dir, "nosleep-go.md"), "utf-8");
    const front = go.split("---")[1];
    expect(front).toMatch(/^description:/m);
    expect(front).not.toMatch(/allowed-tools|argument-hint/);
    expect(go).toContain("$ARGUMENTS"); // body + placeholder preserved
  });

  it("merges the nosleep remote MCP entry into .opencode/opencode.json, preserving other config", () => {
    const project = tempProject();
    mkdirSync(join(project, ".opencode"), { recursive: true });
    writeFileSync(
      join(project, ".opencode", "opencode.json"),
      JSON.stringify({ model: "x/y", mcp: { other: { type: "local", command: ["foo"] } } }),
    );

    installHooks(project, { serverPort: 3777, orgId: "org_work" });

    const cfg = readJson(join(project, ".opencode", "opencode.json"));
    expect(cfg.model).toBe("x/y");
    expect(cfg.mcp.other).toEqual({ type: "local", command: ["foo"] });
    expect(cfg.mcp.nosleep).toEqual({
      type: "remote",
      url: "http://localhost:3777/api/mcp",
      enabled: true,
      headers: { "x-nosleep-org": "org_work" },
    });
  });

  it("leaves an unparseable (JSONC) opencode.json untouched", () => {
    const project = tempProject();
    mkdirSync(join(project, ".opencode"), { recursive: true });
    const jsonc = '{\n  // my comment\n  "model": "x/y"\n}\n';
    writeFileSync(join(project, ".opencode", "opencode.json"), jsonc);

    installHooks(project, { serverPort: 3777, orgId: "org_personal" });

    expect(readFileSync(join(project, ".opencode", "opencode.json"), "utf-8")).toBe(jsonc);
    expect(existsSync(join(project, ".opencode", "plugins", "nosleep.js"))).toBe(true);
  });

  it("is idempotent", () => {
    const project = tempProject();
    installHooks(project, { serverPort: 3777, orgId: "org_personal", targets: ["opencode"] });
    installHooks(project, { serverPort: 3777, orgId: "org_personal", targets: ["opencode"] });

    const cfg = readJson(join(project, ".opencode", "opencode.json"));
    expect(Object.keys(cfg.mcp)).toEqual(["nosleep"]);
    expect(readdirSync(join(project, ".opencode", "plugins"))).toEqual(["nosleep.js"]);
  });
});

describe("uninstallHooks — opencode target", () => {
  it("removes only NoSleep's OpenCode artifacts", () => {
    const project = tempProject();
    mkdirSync(join(project, ".opencode", "commands"), { recursive: true });
    writeFileSync(join(project, ".opencode", "commands", "mine.md"), "---\ndescription: mine\n---\nhi");
    writeFileSync(
      join(project, ".opencode", "opencode.json"),
      JSON.stringify({ mcp: { other: { type: "remote", url: "http://x" } } }),
    );
    installHooks(project, { serverPort: 3777, orgId: "org_personal" });

    uninstallHooks(project);

    expect(existsSync(join(project, ".opencode", "plugins", "nosleep.js"))).toBe(false);
    expect(existsSync(join(project, ".opencode", "nosleep.json"))).toBe(false);
    expect(existsSync(join(project, ".opencode", "skills", "auto-capture"))).toBe(false);
    expect(readdirSync(join(project, ".opencode", "commands"))).toEqual(["mine.md"]);
    const cfg = readJson(join(project, ".opencode", "opencode.json"));
    expect(cfg.mcp).toEqual({ other: { type: "remote", url: "http://x" } });
    // Claude side uninstalled too.
    const settings = readJson(join(project, ".claude", "settings.local.json"));
    expect(settings.hooks.PreToolUse).toHaveLength(0);
  });

  it("does nothing on a project that never had NoSleep", () => {
    const project = tempProject();
    expect(() => uninstallHooks(project)).not.toThrow();
    expect(existsSync(join(project, ".opencode"))).toBe(false);
  });
});

describe("toOpenCodeCommand", () => {
  it("keeps OpenCode keys, drops Claude-only keys, preserves the body", () => {
    const src = '---\ndescription: "Do it"\nargument-hint: "[x]"\nallowed-tools: ["Bash(ls)"]\nmodel: a/b\n---\n\nBody $ARGUMENTS\n';
    expect(toOpenCodeCommand(src)).toBe('---\ndescription: "Do it"\nmodel: a/b\n---\n\nBody $ARGUMENTS\n');
  });

  it("returns files without frontmatter unchanged", () => {
    expect(toOpenCodeCommand("just text")).toBe("just text");
  });
});
