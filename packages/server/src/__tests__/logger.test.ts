import { describe, it, expect, beforeEach } from "vitest";
import { getLogger, _resetLoggerCache } from "../logger.js";

describe("getLogger", () => {
  beforeEach(() => {
    _resetLoggerCache();
  });

  it("returns a logger object with standard pino methods", () => {
    const log = getLogger("test-module");
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
    expect(typeof log.debug).toBe("function");
  });

  it("returns the same instance for the same component name (cached)", () => {
    const a = getLogger("scheduler");
    const b = getLogger("scheduler");
    expect(a).toBe(b);
  });

  it("returns different instances for different components", () => {
    const a = getLogger("scheduler");
    const b = getLogger("session-manager");
    expect(a).not.toBe(b);
  });

  it("respects component context — bindings include component name", () => {
    const log = getLogger("test-bindings");
    const bindings = log.bindings();
    expect(bindings.component).toBe("test-bindings");
  });

  it("does not throw when logging structured data", () => {
    const log = getLogger("test-throw");
    expect(() => log.info({ count: 5, taskName: "x" }, "queued")).not.toThrow();
    expect(() => log.warn({ err: new Error("boom") }, "err")).not.toThrow();
    expect(() => log.error("plain string")).not.toThrow();
  });

  it("_resetLoggerCache forces fresh instance on next call", () => {
    const a = getLogger("reset-test");
    _resetLoggerCache();
    const b = getLogger("reset-test");
    expect(a).not.toBe(b);
  });
});
