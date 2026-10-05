import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { installHooks } from "../../orchestrator/hooks-installer.js";

// Runs the GENERATED post-tool hook exactly as Claude Code would (JSON on
// stdin) against a capture server, and asserts what reaches /api/hooks/post-tool.

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

async function captureServer(): Promise<{ port: number; bodies: Array<Record<string, unknown>> }> {
  const bodies: Array<Record<string, unknown>> = [];
  const server: Server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (req.url === "/api/hooks/post-tool") bodies.push(JSON.parse(data));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ success: true, data: {} }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  cleanups.push(() => server.close());
  return { port: (server.address() as AddressInfo).port, bodies };
}

function runHook(script: string, stdin: unknown): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script], { env: { ...process.env, NOSLEEP_SESSION_ID: "sess_test" } });
    p.stdin.end(JSON.stringify(stdin));
    p.on("exit", (code) => resolve(code ?? -1));
  });
}

async function postToolBody(stdin: Record<string, unknown>) {
  const { port, bodies } = await captureServer();
  const project = mkdtempSync(join(tmpdir(), "nosleep-posttool-"));
  cleanups.push(() => rmSync(project, { recursive: true, force: true }));
  installHooks(project, { serverPort: port, orgId: "org_personal" });
  await runHook(join(project, ".claude", "nosleep-hooks", "post-tool.mjs"), {
    session_id: "cc-1", cwd: project, tool_name: "Read", tool_input: { file_path: "/x" }, ...stdin,
  });
  expect(bodies).toHaveLength(1);
  return bodies[0];
}

describe("generated post-tool hook payload", () => {
  it("forwards Claude Code's tool_response as a string toolResult", async () => {
    const body = await postToolBody({ tool_response: { type: "text", file: { content: "hello" } } });
    expect(typeof body.toolResult).toBe("string");
    expect(JSON.parse(body.toolResult as string)).toEqual({ type: "text", file: { content: "hello" } });
  });

  it("still accepts the legacy tool_result field", async () => {
    const body = await postToolBody({ tool_result: "legacy output" });
    expect(body.toolResult).toBe("legacy output");
  });

  it("truncates huge results to a string the server schema accepts", async () => {
    const body = await postToolBody({ tool_response: "x".repeat(200_000) });
    expect(typeof body.toolResult).toBe("string");
    expect((body.toolResult as string).length).toBeLessThan(3000);
    expect(body.toolResult).toContain("original_size=200000");
  });
});
