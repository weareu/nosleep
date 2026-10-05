import { describe, it, expect, afterEach } from "vitest";
import { installHooks, uninstallHooks } from "../../orchestrator/hooks-installer.js";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

function makeTempDir(): string {
  const dir = join(tmpdir(), `nosleep-test-${randomBytes(8).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("installHooks", () => {
  const tempDirs: string[] = [];

  function getTempDir(): string {
    const dir = makeTempDir();
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    tempDirs.length = 0;
  });

  it("creates .claude directory and nosleep-hooks scripts", () => {
    const projectPath = getTempDir();

    installHooks(projectPath, { serverPort: 3777, orgId: "org_personal" });

    expect(existsSync(join(projectPath, ".claude"))).toBe(true);
    expect(existsSync(join(projectPath, ".claude", "nosleep-hooks"))).toBe(true);
    expect(existsSync(join(projectPath, ".claude", "nosleep-hooks", "pre-tool.mjs"))).toBe(true);
    expect(existsSync(join(projectPath, ".claude", "nosleep-hooks", "post-tool.mjs"))).toBe(true);
    expect(existsSync(join(projectPath, ".claude", "nosleep-hooks", "pre-compact.mjs"))).toBe(true);
    expect(existsSync(join(projectPath, ".claude", "nosleep-hooks", "stop.mjs"))).toBe(true);
  });

  it("creates settings.local.json with correct hook format", () => {
    const projectPath = getTempDir();

    installHooks(projectPath, { serverPort: 3777, orgId: "org_personal" });

    const settingsPath = join(projectPath, ".claude", "settings.local.json");
    expect(existsSync(settingsPath)).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.PreToolUse).toBeInstanceOf(Array);
    expect(settings.hooks.PostToolUse).toBeInstanceOf(Array);
    expect(settings.hooks.PreCompact).toBeInstanceOf(Array);
    expect(settings.hooks.Stop).toBeInstanceOf(Array);

    // Each entry should have matcher + hooks array format
    const preToolEntry = settings.hooks.PreToolUse[0];
    expect(preToolEntry).toHaveProperty("matcher", "");
    expect(preToolEntry.hooks).toBeInstanceOf(Array);
    expect(preToolEntry.hooks[0]).toHaveProperty("type", "command");
    expect(preToolEntry.hooks[0].command).toContain("nosleep-hooks");
    expect(preToolEntry.hooks[0].command).toContain("pre-tool.mjs");
  });

  it("hook scripts contain correct server URL and org ID", () => {
    const projectPath = getTempDir();

    installHooks(projectPath, { serverPort: 4000, orgId: "org_wyobi" });

    const preTool = readFileSync(
      join(projectPath, ".claude", "nosleep-hooks", "pre-tool.mjs"),
      "utf-8",
    );
    expect(preTool).toContain("http://localhost:4000");
    expect(preTool).toContain("org_wyobi");
  });

  it("preserves existing settings (other keys)", () => {
    const projectPath = getTempDir();
    const claudeDir = join(projectPath, ".claude");
    mkdirSync(claudeDir, { recursive: true });

    // Write existing settings with permissions
    const existing = {
      permissions: { allow: ["Read", "Write"] },
      someOtherKey: "keep-me",
    };
    writeFileSync(
      join(claudeDir, "settings.local.json"),
      JSON.stringify(existing, null, 2),
    );

    installHooks(projectPath, { serverPort: 3777, orgId: "org_personal" });

    const settings = JSON.parse(
      readFileSync(join(claudeDir, "settings.local.json"), "utf-8"),
    );

    // Hooks should be added
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.PreToolUse).toBeInstanceOf(Array);

    // Existing keys should be preserved
    expect(settings.permissions).toEqual({ allow: ["Read", "Write"] });
    expect(settings.someOtherKey).toBe("keep-me");
  });

  it("preserves existing non-nosleep hooks", () => {
    const projectPath = getTempDir();
    const claudeDir = join(projectPath, ".claude");
    mkdirSync(claudeDir, { recursive: true });

    // Write existing settings with a custom hook
    const existing = {
      hooks: {
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "my-custom-linter", timeout: 3000 }],
          },
        ],
      },
    };
    writeFileSync(
      join(claudeDir, "settings.local.json"),
      JSON.stringify(existing, null, 2),
    );

    installHooks(projectPath, { serverPort: 3777, orgId: "org_personal" });

    const settings = JSON.parse(
      readFileSync(join(claudeDir, "settings.local.json"), "utf-8"),
    );

    // Should have both the custom hook and the nosleep hook
    expect(settings.hooks.PostToolUse).toHaveLength(2);
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe("my-custom-linter");
    expect(settings.hooks.PostToolUse[1].hooks[0].command).toContain("nosleep-hooks");
  });

  it("is idempotent - running twice does not duplicate nosleep hooks", () => {
    const projectPath = getTempDir();

    installHooks(projectPath, { serverPort: 3777, orgId: "org_personal" });
    installHooks(projectPath, { serverPort: 3777, orgId: "org_personal" });

    const settings = JSON.parse(
      readFileSync(join(projectPath, ".claude", "settings.local.json"), "utf-8"),
    );

    // Each hook type should have exactly one nosleep entry
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.PreCompact).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
  });
});

describe("uninstallHooks", () => {
  const tempDirs: string[] = [];

  function getTempDir(): string {
    const dir = makeTempDir();
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    tempDirs.length = 0;
  });

  it("removes nosleep hooks from settings", () => {
    const projectPath = getTempDir();

    // First install hooks
    installHooks(projectPath, { serverPort: 3777, orgId: "org_personal" });

    // Verify they exist
    let settings = JSON.parse(
      readFileSync(join(projectPath, ".claude", "settings.local.json"), "utf-8"),
    );
    expect(settings.hooks.PreToolUse).toHaveLength(1);

    // Uninstall
    uninstallHooks(projectPath);

    settings = JSON.parse(
      readFileSync(join(projectPath, ".claude", "settings.local.json"), "utf-8"),
    );

    // All nosleep hooks should be removed
    expect(settings.hooks.PreToolUse).toHaveLength(0);
    expect(settings.hooks.PostToolUse).toHaveLength(0);
    expect(settings.hooks.PreCompact).toHaveLength(0);
    expect(settings.hooks.Stop).toHaveLength(0);
  });

  it("preserves non-nosleep hooks when uninstalling", () => {
    const projectPath = getTempDir();
    const claudeDir = join(projectPath, ".claude");
    mkdirSync(claudeDir, { recursive: true });

    // Set up settings with both custom and nosleep hooks
    const existing = {
      hooks: {
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "my-custom-linter", timeout: 3000 }],
          },
        ],
      },
    };
    writeFileSync(
      join(claudeDir, "settings.local.json"),
      JSON.stringify(existing, null, 2),
    );

    // Install nosleep hooks (adds to existing)
    installHooks(projectPath, { serverPort: 3777, orgId: "org_personal" });

    // Uninstall nosleep hooks
    uninstallHooks(projectPath);

    const settings = JSON.parse(
      readFileSync(join(claudeDir, "settings.local.json"), "utf-8"),
    );

    // Custom hook should remain
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe("my-custom-linter");
  });

  it("does nothing if settings file does not exist", () => {
    const projectPath = getTempDir();

    // Should not throw
    expect(() => uninstallHooks(projectPath)).not.toThrow();
  });

  it("does nothing if settings has no hooks key", () => {
    const projectPath = getTempDir();
    const claudeDir = join(projectPath, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, "settings.local.json"),
      JSON.stringify({ permissions: {} }),
    );

    expect(() => uninstallHooks(projectPath)).not.toThrow();
  });
});
