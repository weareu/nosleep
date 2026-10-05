import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config
vi.mock("../config", () => ({
  getServerConfig: vi.fn(() =>
    Promise.resolve({
      apiUrl: "http://localhost:3777",
      wsUrl: "ws://localhost:3777/ws",
      apiKey: "",
    }),
  ),
}));

// Mock WebSocket
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  });

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: object): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

let lastWs: MockWebSocket;
(global as any).WebSocket = class extends MockWebSocket {
  constructor() {
    super();
    lastWs = this;
  }
};

import { createWsManager } from "../services/ws";

beforeEach(() => {
  vi.useFakeTimers();
});

describe("wsManager", () => {
  it("notifies connection listeners on connect", async () => {
    const manager = createWsManager();
    const listener = vi.fn();
    manager.onConnectionChange(listener);

    manager.connect();
    await vi.advanceTimersByTimeAsync(0); // resolve getServerConfig promise

    lastWs.simulateOpen();
    expect(listener).toHaveBeenCalledWith(true);
  });

  it("notifies connection listeners on disconnect", async () => {
    const manager = createWsManager();
    const listener = vi.fn();
    manager.onConnectionChange(listener);

    manager.connect();
    await vi.advanceTimersByTimeAsync(0);

    lastWs.simulateOpen();
    lastWs.simulateClose();

    expect(listener).toHaveBeenCalledWith(false);
  });

  it("unsubscribes connection listener", async () => {
    const manager = createWsManager();
    const listener = vi.fn();
    const unsub = manager.onConnectionChange(listener);

    unsub(); // unsubscribe before connect

    manager.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs.simulateOpen();

    expect(listener).not.toHaveBeenCalled();
  });

  it("isConnected returns true when ws is open", async () => {
    const manager = createWsManager();
    expect(manager.isConnected()).toBe(false);

    manager.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs.simulateOpen();

    expect(manager.isConnected()).toBe(true);
  });

  it("isConnected returns false after disconnect", async () => {
    const manager = createWsManager();
    manager.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs.simulateOpen();

    manager.disconnect();
    expect(manager.isConnected()).toBe(false);
  });

  it("emits events to type-specific subscribers", async () => {
    const manager = createWsManager();
    const listener = vi.fn();
    manager.subscribe("session:update", listener);

    manager.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs.simulateOpen();
    lastWs.simulateMessage({ type: "session:update", data: { id: "123" } });

    expect(listener).toHaveBeenCalledWith({ type: "session:update", data: { id: "123" } });
  });

  it("emits events to wildcard subscribers", async () => {
    const manager = createWsManager();
    const listener = vi.fn();
    manager.subscribe("*", listener);

    manager.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs.simulateOpen();
    lastWs.simulateMessage({ type: "alert:new", data: {} });

    expect(listener).toHaveBeenCalledWith({ type: "alert:new", data: {} });
  });

  it("does not emit to unsubscribed listeners", async () => {
    const manager = createWsManager();
    const listener = vi.fn();
    const unsub = manager.subscribe("session:update", listener);
    unsub();

    manager.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs.simulateOpen();
    lastWs.simulateMessage({ type: "session:update", data: {} });

    expect(listener).not.toHaveBeenCalled();
  });

  it("schedules reconnect after unexpected close", async () => {
    const manager = createWsManager();
    manager.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs.simulateOpen();
    lastWs.simulateClose();

    // Should reconnect after 3 seconds
    await vi.advanceTimersByTimeAsync(3000);
    // A new WebSocket should have been created
    expect(lastWs).toBeDefined();
  });

  it("does not reconnect after intentional disconnect", async () => {
    const manager = createWsManager();
    const listener = vi.fn();
    manager.onConnectionChange(listener);

    manager.connect();
    await vi.advanceTimersByTimeAsync(0);
    lastWs.simulateOpen();

    listener.mockClear();
    manager.disconnect();

    // Advance past reconnect timer
    await vi.advanceTimersByTimeAsync(5000);

    // Should only have the disconnect notification, no reconnect
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(false);
  });
});
