import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { NoSleepPlugin } from "../../../../opencode-plugin/nosleep.js";

/**
 * Behaviour tests for the OpenCode plugin's event → NoSleep payload mapping.
 * A fake fetch records every request and answers per path; the payload
 * shapes asserted here are the ones the Claude hook scripts send.
 */

interface Call { url: string; body: Record<string, unknown>; headers: Record<string, string> }

const BASE = "http://ns.test:3777";
const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  tempDirs.length = 0;
});

function tempProject(): string {
  const dir = join(tmpdir(), `nosleep-ocp-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

type Responder = (path: string, body: Record<string, unknown>) => unknown;

function fakeFetch(respond: Responder = () => ({})) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: { body: string; headers: Record<string, string> }) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    const path = url.slice(BASE.length);
    if (path === "/api/sessions/register") {
      return new Response(JSON.stringify({ success: true, data: { sessionId: "manual_ns1" } }), { status: 201 });
    }
    return new Response(JSON.stringify(respond(path, body) ?? {}), { status: 200 });
  };
  const paths = () => calls.map((c) => c.url.slice(BASE.length));
  const callTo = (path: string) => calls.filter((c) => c.url === BASE + path);
  return { fetch, calls, paths, callTo };
}

async function setup(opts: {
  respond?: Responder;
  env?: Record<string, string>;
  client?: unknown;
  project?: string;
} = {}) {
  const project = opts.project ?? tempProject();
  const ff = fakeFetch(opts.respond);
  const hooks = (await NoSleepPlugin({
    directory: project,
    worktree: project,
    client: opts.client as never,
    env: { NOSLEEP_URL: BASE, NOSLEEP_ORG_ID: "org_work", ...opts.env },
    fetch: ff.fetch as never,
    configPath: join(project, "no-such-config.json"),
  })) as Record<string, (a?: unknown, b?: unknown) => Promise<void>>;
  return { hooks, project, ...ff };
}

describe("session registration", () => {
  it("registers once per OpenCode session with the Claude-hook register payload + agent", async () => {
    const { hooks, project, callTo } = await setup();
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_A", callID: "1" }, { args: { command: "ls" } });
    await hooks["tool.execute.before"]({ tool: "read", sessionID: "ses_A", callID: "2" }, { args: { filePath: "/x" } });

    const reg = callTo("/api/sessions/register");
    expect(reg).toHaveLength(1);
    expect(reg[0].body).toEqual({
      orgId: "org_work",
      projectPath: project,
      claudeSessionId: "ses_A",
      cwd: project,
      agent: "opencode",
    });
  });

  it("uses NOSLEEP_SESSION_ID without registering (orchestrated sessions)", async () => {
    const { hooks, callTo } = await setup({ env: { NOSLEEP_SESSION_ID: "sess_orch" } });
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_A", callID: "1" }, { args: {} });
    expect(callTo("/api/sessions/register")).toHaveLength(0);
    expect(callTo("/api/hooks/pre-tool")[0].body.sessionId).toBe("sess_orch");
  });

  it("sends x-hook-secret when NOSLEEP_HOOK_SECRET is set", async () => {
    const { hooks, calls } = await setup({ env: { NOSLEEP_HOOK_SECRET: "s3cret" } });
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_A", callID: "1" }, { args: {} });
    expect(calls.every((c) => c.headers["x-hook-secret"] === "s3cret")).toBe(true);
  });

  it("falls back to the installer-written nosleep.json for org/URL/project path", async () => {
    const project = tempProject();
    const cfgPath = join(project, "nosleep.json");
    writeFileSync(cfgPath, JSON.stringify({ orgId: "org_side", baseUrl: BASE, projectPath: "/repo/root" }));
    const ff = fakeFetch();
    const hooks = (await NoSleepPlugin({
      directory: project, worktree: project, env: {}, fetch: ff.fetch as never, configPath: cfgPath,
    })) as Record<string, (a?: unknown, b?: unknown) => Promise<void>>;
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "1" }, { args: {} });
    expect(ff.callTo("/api/sessions/register")[0].body).toMatchObject({ orgId: "org_side", projectPath: "/repo/root" });
  });

  it("is disabled for brain-internal headless runs", async () => {
    const hooks = await NoSleepPlugin({ env: { NOSLEEP_BRAIN_INTERNAL: "1" }, fetch: (async () => { throw new Error("no"); }) as never });
    expect(hooks).toEqual({});
  });
});

describe("tool.execute.before → /api/hooks/pre-tool", () => {
  it("maps OpenCode tool ids/args to the Claude names the server keys off", async () => {
    const { hooks, callTo } = await setup();
    await hooks["tool.execute.before"](
      { tool: "edit", sessionID: "ses_A", callID: "1" },
      { args: { filePath: "/p/a.ts", oldString: "a", newString: "b" } },
    );
    expect(callTo("/api/hooks/pre-tool")[0].body).toEqual({
      orgId: "org_work",
      sessionId: "manual_ns1",
      toolName: "Edit",
      toolInput: { filePath: "/p/a.ts", file_path: "/p/a.ts", oldString: "a", newString: "b" },
    });
  });

  it("passes MCP/custom tool names through unchanged", async () => {
    const { hooks, callTo } = await setup();
    await hooks["tool.execute.before"]({ tool: "nosleep_nosleep", sessionID: "s", callID: "1" }, { args: { action: "x" } });
    expect(callTo("/api/hooks/pre-tool")[0].body.toolName).toBe("nosleep_nosleep");
  });

  it("delivers a returned supervision message into the NEXT system prompt of that session only, once", async () => {
    const { hooks } = await setup({
      respond: (p) => (p === "/api/hooks/pre-tool" ? { message: "Token budget at 85%." } : {}),
    });
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_A", callID: "1" }, { args: {} });

    const other = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "ses_B" }, other);
    expect(other.system).toEqual([]);

    const mine = { system: ["base"] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "ses_A" }, mine);
    expect(mine.system).toEqual(["base", "[NoSleep]\nToken budget at 85%."]);

    const again = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "ses_A" }, again);
    expect(again.system).toEqual([]);
  });
});

describe("tool.execute.after → /api/hooks/post-tool", () => {
  it("sends tool name, input and a STRING result, truncating large output", async () => {
    const { hooks, callTo } = await setup();
    const big = "x".repeat(70000);
    await hooks["tool.execute.after"](
      { tool: "read", sessionID: "ses_A", callID: "1", args: { filePath: "/f" } },
      { title: "f", output: big, metadata: {} },
    );
    const body = callTo("/api/hooks/post-tool")[0].body;
    expect(body).toMatchObject({ orgId: "org_work", sessionId: "manual_ns1", toolName: "Read", toolInput: { file_path: "/f" } });
    expect(typeof body.toolResult).toBe("string");
    expect((body.toolResult as string).length).toBeLessThan(66000);
    expect(body.toolResult as string).toContain("original_size=70000");
  });

  it("counts only real tools in the shared .claude/.nosleep-tool-count file", async () => {
    const { hooks, project } = await setup();
    const after = (tool: string) =>
      hooks["tool.execute.after"]({ tool, sessionID: "s", callID: "1", args: {} }, { title: "", output: "", metadata: {} });
    await after("bash");
    await after("edit");
    await after("todowrite");
    await after("nosleep_nosleep");
    expect(readFileSync(join(project, ".claude", ".nosleep-tool-count"), "utf-8")).toBe("2");
  });
});

describe("chat.message → /api/brain/hook-ingest/user-prompt", () => {
  it("ingests the user's text parts, skipping synthetic and non-text parts", async () => {
    const { hooks, callTo } = await setup();
    await hooks["chat.message"]({ sessionID: "ses_A" }, {
      message: {},
      parts: [
        { type: "text", text: "fix the bug" },
        { type: "text", text: "injected", synthetic: true },
        { type: "file", url: "file:///x" },
        { type: "text", text: "in auth.ts" },
      ],
    });
    expect(callTo("/api/brain/hook-ingest/user-prompt")[0].body).toEqual({
      orgId: "org_work",
      sessionId: "manual_ns1",
      prompt: "fix the bug\nin auth.ts",
    });
  });

  it("does nothing for an empty message", async () => {
    const { hooks, calls } = await setup();
    await hooks["chat.message"]({ sessionID: "ses_A" }, { message: {}, parts: [] });
    expect(calls).toHaveLength(0);
  });
});

describe("experimental.session.compacting → /api/hooks/pre-compact", () => {
  it("reports compaction and carries undelivered messages into the compaction context", async () => {
    const { hooks, callTo } = await setup({
      respond: (p) => (p === "/api/hooks/pre-tool" ? { message: "Next task: T42" } : {}),
    });
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "ses_A", callID: "1" }, { args: {} });
    const output = { context: [] as string[] };
    await hooks["experimental.session.compacting"]({ sessionID: "ses_A" }, output);

    expect(callTo("/api/hooks/pre-compact")[0].body).toEqual({ orgId: "org_work", sessionId: "manual_ns1" });
    expect(output.context).toHaveLength(1);
    expect(output.context[0]).toContain("Next task: T42");
  });
});

describe("session.idle → Stop-hook flow", () => {
  const idle = (hooks: Record<string, (a?: unknown) => Promise<void>>, id = "ses_A") =>
    hooks.event({ event: { type: "session.idle", properties: { sessionID: id } } });

  it("does nothing beyond registering when neither connected nor looping", async () => {
    const { hooks, paths } = await setup();
    await idle(hooks);
    expect(paths()).toEqual(["/api/sessions/register"]);
  });

  it("connected session: drains steering and sends it as a new user turn via the SDK client", async () => {
    const project = tempProject();
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(join(project, ".claude", ".nosleep-connected"), "connected");
    const prompts: unknown[] = [];
    const client = { session: { prompt: async (a: unknown) => { prompts.push(a); } } };
    const { hooks, paths } = await setup({
      project,
      client,
      respond: (p) => (p === "/api/sessions/manual_ns1/drain" ? { success: true, data: { message: "Switch to T7" } } : {}),
    });
    await idle(hooks);
    expect(paths()).toContain("/api/sessions/manual_ns1/drain");
    expect(prompts).toEqual([{ path: { id: "ses_A" }, body: { parts: [{ type: "text", text: "Switch to T7" }] } }]);
  });

  it("loop active with real work: stop → decide-next → schedule-wake with the decided delay", async () => {
    const project = tempProject();
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(join(project, ".claude", ".nosleep-loop-active"), '{"delayMinutes": 15}');
    writeFileSync(join(project, ".claude", ".nosleep-tool-count"), "7");
    const { hooks, paths, callTo } = await setup({
      project,
      respond: (p) =>
        p === "/api/sessions/manual_ns1/decide-next" ? { success: true, data: { action: "next_task", delayMinutes: 15 } } : {},
    });
    await idle(hooks);
    expect(paths()).toEqual([
      "/api/sessions/register",
      "/api/hooks/stop",
      "/api/sessions/manual_ns1/decide-next",
      "/api/sessions/manual_ns1/schedule-wake",
    ]);
    expect(callTo("/api/hooks/stop")[0].body).toEqual({ orgId: "org_work", sessionId: "manual_ns1", stopReason: "end_turn" });
    expect(callTo("/api/sessions/manual_ns1/schedule-wake")[0].body).toEqual({ delayMinutes: 15 });
  });

  it("loop active but decision is stop: no wake scheduled", async () => {
    const project = tempProject();
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(join(project, ".claude", ".nosleep-loop-active"), "{}");
    writeFileSync(join(project, ".claude", ".nosleep-tool-count"), "9");
    const { hooks, paths } = await setup({
      project,
      respond: (p) => (p.endsWith("/decide-next") ? { success: true, data: { action: "stop" } } : {}),
    });
    await idle(hooks);
    expect(paths()).not.toContain("/api/sessions/manual_ns1/schedule-wake");
  });

  it("loop active but < 5 real tool calls: no loop calls (mirrors the Claude Stop hook)", async () => {
    const project = tempProject();
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(join(project, ".claude", ".nosleep-loop-active"), "{}");
    writeFileSync(join(project, ".claude", ".nosleep-tool-count"), "2");
    const { hooks, paths } = await setup({ project });
    await idle(hooks);
    expect(paths()).toEqual(["/api/sessions/register"]);
  });
});

describe("fail-open", () => {
  it("never throws into OpenCode when the server is down", async () => {
    const project = tempProject();
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(join(project, ".claude", ".nosleep-connected"), "connected");
    writeFileSync(join(project, ".claude", ".nosleep-loop-active"), "{}");
    writeFileSync(join(project, ".claude", ".nosleep-tool-count"), "9");
    let attempts = 0;
    const hooks = (await NoSleepPlugin({
      directory: project,
      worktree: project,
      env: { NOSLEEP_URL: BASE },
      configPath: join(project, "none.json"),
      fetch: (async () => { attempts++; throw new TypeError("fetch failed: ECONNREFUSED"); }) as never,
    })) as Record<string, (a?: unknown, b?: unknown) => Promise<void>>;

    const args = { args: { command: "ls" } };
    await expect(hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "1" }, args)).resolves.toBeUndefined();
    await expect(hooks["tool.execute.after"]({ tool: "bash", sessionID: "s", callID: "1", args: {} }, { output: "ok" })).resolves.toBeUndefined();
    await expect(hooks["chat.message"]({ sessionID: "s" }, { parts: [{ type: "text", text: "hi" }] })).resolves.toBeUndefined();
    await expect(hooks["experimental.session.compacting"]({ sessionID: "s" }, { context: [] })).resolves.toBeUndefined();
    await expect(hooks.event({ event: { type: "session.idle", properties: { sessionID: "s" } } })).resolves.toBeUndefined();
    expect(args.args).toEqual({ command: "ls" }); // tool args never mutated
    expect(attempts).toBeGreaterThan(0);
    // Register failure is retried on the next hook, not cached as null.
    const before = attempts;
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "2" }, args);
    expect(attempts).toBeGreaterThan(before);
  });

  it("treats non-2xx responses as no-ops", async () => {
    const project = tempProject();
    const hooks = (await NoSleepPlugin({
      directory: project, worktree: project, env: { NOSLEEP_URL: BASE }, configPath: join(project, "none.json"),
      fetch: (async () => new Response("nope", { status: 500 })) as never,
    })) as Record<string, (a?: unknown, b?: unknown) => Promise<void>>;
    const out = { system: [] as string[] };
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "1" }, { args: {} });
    await hooks["experimental.chat.system.transform"]({ sessionID: "s" }, out);
    expect(out.system).toEqual([]);
    expect(existsSync(join(project, ".claude"))).toBe(false);
  });
});
