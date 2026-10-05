import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// Mock spawn so no real `claude` process is launched. The mock records the
// args/options it was called with so we can assert the call shape.
const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { runClaudeHeadless, __resetHeadlessCircuit } from "../../lib/headless-claude.js";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

describe("runClaudeHeadless", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    __resetHeadlessCircuit();
  });

  it("spawns with stdin closed (stdio ignore) and a scratch cwd — the 3s stdin-wait fix", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const p = runClaudeHeadless(["--print", "hi"], { timeoutMs: 5000 });
    child.emit("close", 0);
    await p;

    const [cmd, args, opts] = spawnMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(cmd).toBe("claude");
    expect(args).toEqual(["--print", "hi"]);
    // stdin must be "ignore" → immediate EOF, no 3s wait.
    expect((opts.stdio as unknown[])[0]).toBe("ignore");
    // transcripts isolated to the scratch bucket, never a real project's dir.
    expect(String(opts.cwd)).toMatch(/\.nosleep[/\\]headless$/);
  });

  it("strips CLAUDECODE from the child env", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const prev = process.env.CLAUDECODE;
    process.env.CLAUDECODE = "1";
    try {
      const p = runClaudeHeadless(["--version"], { timeoutMs: 5000 });
      child.emit("close", 0);
      await p;
      const opts = spawnMock.mock.calls[0][2] as { env: Record<string, string> };
      expect(opts.env.CLAUDECODE).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = prev;
    }
  });

  it("resolves with collected stdout/stderr on exit 0", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const p = runClaudeHeadless(["--print", "x"], { timeoutMs: 5000 });
    child.stdout.emit("data", Buffer.from("out-part-1"));
    child.stdout.emit("data", Buffer.from("|part-2"));
    child.stderr.emit("data", Buffer.from("warn"));
    child.emit("close", 0);

    await expect(p).resolves.toEqual({ stdout: "out-part-1|part-2", stderr: "warn" });
  });

  it("rejects with the exit code and stderr on non-zero exit", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const p = runClaudeHeadless(["--print", "x"], { timeoutMs: 5000 });
    child.stderr.emit("data", Buffer.from("boom detail"));
    child.emit("close", 2);

    await expect(p).rejects.toThrow(/exited 2.*boom detail/);
  });

  it("SIGKILLs and rejects on timeout", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);

      const p = runClaudeHeadless(["--print", "x"], { timeoutMs: 1000 });
      const assertion = expect(p).rejects.toThrow(/timed out after 1000ms/);
      vi.advanceTimersByTime(1000);
      await assertion;
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects when the process emits an error (e.g. claude not found)", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const p = runClaudeHeadless(["--version"], { timeoutMs: 5000 });
    child.emit("error", new Error("ENOENT"));

    await expect(p).rejects.toThrow(/ENOENT/);
  });

  it("opens the circuit after 5 consecutive failures and fails fast without spawning", async () => {
    for (let i = 0; i < 5; i++) {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      const p = runClaudeHeadless(["--print", "x"], { timeoutMs: 5000 });
      child.emit("close", 1);
      await expect(p).rejects.toThrow(/exited 1/);
    }
    expect(spawnMock).toHaveBeenCalledTimes(5);

    // 6th call: circuit open → rejected immediately, NO new spawn.
    await expect(runClaudeHeadless(["--print", "x"], { timeoutMs: 5000 })).rejects.toThrow(/circuit open/);
    expect(spawnMock).toHaveBeenCalledTimes(5);
  });

  it("a success closes the failure streak (no circuit)", async () => {
    for (let i = 0; i < 4; i++) {
      const child = fakeChild();
      spawnMock.mockReturnValue(child);
      const p = runClaudeHeadless(["--print", "x"], { timeoutMs: 5000 });
      child.emit("close", 1);
      await expect(p).rejects.toThrow();
    }
    // Success resets the streak…
    const ok = fakeChild();
    spawnMock.mockReturnValue(ok);
    const pOk = runClaudeHeadless(["--print", "x"], { timeoutMs: 5000 });
    ok.emit("close", 0);
    await pOk;

    // …so the next failure is streak=1, circuit stays closed.
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const p = runClaudeHeadless(["--print", "x"], { timeoutMs: 5000 });
    child.emit("close", 1);
    await expect(p).rejects.toThrow(/exited 1/); // not "circuit open"
  });
});
