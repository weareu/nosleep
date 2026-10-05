import { describe, it, expect } from "vitest";
import { fillEnv, readEnvValue, renderServices, servicePath } from "../install.mjs";

const base = { repo: "/opt/nosleep", home: "/home/ada", nodeBin: "/usr/local/node/bin/node", claudeBin: "/home/ada/.local/bin/claude" };

describe("fillEnv", () => {
  it("generates only the blank auth keys and preserves everything else", () => {
    let n = 0;
    const out = fillEnv("PORT=3777\nNOSLEEP_API_KEY=\nNOSLEEP_HOOK_SECRET=\n# ANTHROPIC_API_KEY=x\n", () => `k${++n}`);
    expect(out).toBe("PORT=3777\nNOSLEEP_API_KEY=k1\nNOSLEEP_HOOK_SECRET=k2\n# ANTHROPIC_API_KEY=x\n");
  });
  it("never overwrites an existing key (re-run is idempotent)", () => {
    const body = "NOSLEEP_API_KEY=keep\nNOSLEEP_HOOK_SECRET=also\n";
    expect(fillEnv(body, () => "new")).toBe(body);
    expect(readEnvValue(body, "NOSLEEP_API_KEY")).toBe("keep");
  });
});

describe("servicePath", () => {
  it("puts node and claude first so the service can spawn sessions", () => {
    const p = servicePath({ ...base, os: "linux" }).split(":");
    expect(p.slice(0, 2)).toEqual(["/usr/local/node/bin", "/home/ada/.local/bin"]);
    expect(new Set(p).size).toBe(p.length);
  });
});

describe("renderServices", () => {
  it("macOS: server, web and watchdog LaunchAgents rooted at the repo, no hardcoded user", () => {
    const s = renderServices({ ...base, os: "darwin" });
    expect(s.map((x) => x.name)).toEqual(["com.nosleep.server", "com.nosleep.web", "com.nosleep.watchdog"]);
    expect(s[0].path).toBe("/home/ada/Library/LaunchAgents/com.nosleep.server.plist");
    expect(s[0].content).toContain("<string>/opt/nosleep/packages/server/src/server.ts</string>");
    expect(s[2].content).toContain("<string>/opt/nosleep/scripts/watchdog.sh</string>");
    for (const x of s) expect(x.content).not.toMatch(/\/Users\/(?!ada)[^/]+/);
  });
  it("linux: systemd user units that restart on failure", () => {
    const s = renderServices({ ...base, os: "linux" });
    expect(s.map((x) => x.path)).toEqual([
      "/home/ada/.config/systemd/user/nosleep-server.service",
      "/home/ada/.config/systemd/user/nosleep-web.service",
    ]);
    expect(s[0].content).toMatch(/ExecStart="\/usr\/local\/node\/bin\/node" "\/opt\/nosleep\/node_modules\/tsx\/dist\/cli.mjs"/);
    expect(s[0].content).toContain("Restart=on-failure");
  });
  it("windows: logon-task launch scripts", () => {
    const s = renderServices({ ...base, os: "win32" });
    expect(s.map((x) => x.name)).toEqual(["NoSleepServer", "NoSleepWeb"]);
    expect(s[0].content).toContain("\r\n");
  });
  it("rejects unsupported platforms instead of writing nothing silently", () => {
    expect(() => renderServices({ ...base, os: "aix" })).toThrow(/Unsupported/);
  });
});
