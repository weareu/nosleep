import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// Mock the event-bus module so we can emit events into the broadcaster
vi.mock("../../event-bus.js", () => {
  const bus = new EventEmitter();
  bus.setMaxListeners(50);
  return { eventBus: bus };
});

import { eventBus } from "../../event-bus.js";
import { registerClient, broadcast, initBroadcaster, shutdownHeartbeat } from "../../websocket/broadcast.js";

interface FakeSocket {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  ping: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  _handlers: Map<string, (...args: unknown[]) => void>;
}

function fakeSocket(readyState: number = 1): FakeSocket {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    readyState,
    send: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
    }),
    ping: vi.fn(),
    terminate: vi.fn(),
    _handlers: handlers,
  };
}

describe("WebSocket broadcaster", () => {
  beforeEach(() => {
    eventBus.removeAllListeners();
  });

  afterEach(() => {
    shutdownHeartbeat();
    eventBus.removeAllListeners();
  });

  it("broadcast() sends to all OPEN clients", () => {
    const a = fakeSocket(1);
    const b = fakeSocket(1);
    registerClient(a as never);
    registerClient(b as never);

    broadcast("session:update", { id: "s1" });

    expect(a.send).toHaveBeenCalledTimes(1);
    expect(b.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(a.send.mock.calls[0][0] as string);
    expect(payload.type).toBe("session:update");
    expect(payload.data).toEqual({ id: "s1" });
    expect(payload.timestamp).toBeDefined();
  });

  it("broadcast() skips clients in non-OPEN state", () => {
    const open = fakeSocket(1);
    const closing = fakeSocket(2); // CLOSING
    const closed = fakeSocket(3); // CLOSED
    registerClient(open as never);
    registerClient(closing as never);
    registerClient(closed as never);

    broadcast("alert:new", { id: 1 });

    expect(open.send).toHaveBeenCalledTimes(1);
    expect(closing.send).not.toHaveBeenCalled();
    expect(closed.send).not.toHaveBeenCalled();
  });

  it("registerClient wires close handler that removes the client", () => {
    const a = fakeSocket(1);
    registerClient(a as never);

    // Simulate close event
    const closeHandler = a._handlers.get("close")!;
    expect(closeHandler).toBeDefined();
    closeHandler();

    // After close, broadcast should not reach this client
    broadcast("session:update", { id: "ignored" });
    expect(a.send).not.toHaveBeenCalled();
  });

  it("initBroadcaster forwards session:update events from eventBus to clients", () => {
    initBroadcaster();
    const c = fakeSocket(1);
    registerClient(c as never);

    // Partial payload is intentional — we only assert the broadcast wiring.
    eventBus.emit("session:update", { id: "evtSess", status: "running" } as never);

    expect(c.send).toHaveBeenCalled();
    const payload = JSON.parse(c.send.mock.calls[0][0] as string);
    expect(payload.type).toBe("session:update");
    expect((payload.data as { id: string }).id).toBe("evtSess");
  });

  it("initBroadcaster truncates session:output text > 2000 chars", () => {
    initBroadcaster();
    const c = fakeSocket(1);
    registerClient(c as never);

    const huge = "x".repeat(5000);
    eventBus.emit("session:output", "s1", huge);

    expect(c.send).toHaveBeenCalled();
    const payload = JSON.parse(c.send.mock.calls[0][0] as string) as {
      data: { sessionId: string; text: string };
    };
    expect(payload.data.sessionId).toBe("s1");
    expect(payload.data.text.length).toBe(2000);
    // Should be the trailing 2000 chars (slice(-2000))
    expect(payload.data.text).toBe("x".repeat(2000));
  });

  it("initBroadcaster passes alert:new events through unchanged", () => {
    initBroadcaster();
    const c = fakeSocket(1);
    registerClient(c as never);

    eventBus.emit("alert:new", { id: 42, message: "yo" } as never);

    const payload = JSON.parse(c.send.mock.calls[0][0] as string);
    expect(payload.type).toBe("alert:new");
    expect(payload.data).toEqual({ id: 42, message: "yo" });
  });

  it("initBroadcaster wraps supervision events with action label", () => {
    initBroadcaster();
    const c = fakeSocket(1);
    registerClient(c as never);

    eventBus.emit("supervision:goal-injected", "sessXYZ");

    const payload = JSON.parse(c.send.mock.calls[0][0] as string) as {
      type: string;
      data: { action: string; sessionId: string };
    };
    expect(payload.type).toBe("supervision:action");
    expect(payload.data.action).toBe("goal-injected");
    expect(payload.data.sessionId).toBe("sessXYZ");
  });

  it("initBroadcaster wraps drift detection with confidence + reason", () => {
    initBroadcaster();
    const c = fakeSocket(1);
    registerClient(c as never);

    eventBus.emit("supervision:drift-detected", "s1", 0.85, "off-topic tool use");

    const payload = JSON.parse(c.send.mock.calls[0][0] as string) as {
      data: { action: string; confidence: number; reason: string };
    };
    expect(payload.data.action).toBe("drift-detected");
    expect(payload.data.confidence).toBe(0.85);
    expect(payload.data.reason).toBe("off-topic tool use");
  });

  it("broadcast does not throw when there are zero clients", () => {
    expect(() => broadcast("session:update", { id: "x" })).not.toThrow();
  });
});
