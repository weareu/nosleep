import type { WebSocket } from "ws";
import { eventBus } from "../event-bus.js";
import type { WsEvent, WsEventType } from "@nosleep/shared";
import { WS_HEARTBEAT_INTERVAL_MS } from "@nosleep/shared";

const clients = new Set<WebSocket>();
const aliveMap = new WeakMap<WebSocket, boolean>();
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

export function registerClient(socket: WebSocket): void {
  clients.add(socket);
  aliveMap.set(socket, true);

  socket.on("pong", () => {
    aliveMap.set(socket, true);
  });

  socket.on("close", () => {
    clients.delete(socket);
  });
}

export function broadcast<T>(type: WsEventType, data: T): void {
  const event: WsEvent<T> = {
    type,
    data,
    timestamp: new Date().toISOString(),
  };

  const payload = JSON.stringify(event);

  for (const client of clients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(payload);
    }
  }
}

/**
 * Wire the event bus to WebSocket broadcasts.
 * Call once during server startup.
 */
export function initBroadcaster(): void {
  eventBus.on("session:update", (session) => {
    broadcast("session:update", session);
  });

  eventBus.on("session:output", (sessionId, text) => {
    // Truncate large output to prevent DoS on mobile/dashboard clients
    const truncated = typeof text === "string" && text.length > 2000
      ? text.slice(-2000)
      : text;
    broadcast("session:output", { sessionId, text: truncated });
  });

  eventBus.on("alert:new", (alert) => {
    broadcast("alert:new", alert);
  });

  eventBus.on("alert:ack", (alertId) => {
    broadcast("alert:ack", { alertId });
  });

  eventBus.on("alert:unack", (alertId) => {
    broadcast("alert:unack", { alertId });
  });

  eventBus.on("budget:update", (usage) => {
    broadcast("budget:update", usage);
  });

  eventBus.on("validation:result", (result) => {
    broadcast("validation:result", result);
  });

  eventBus.on("goal:progress", (goal) => {
    broadcast("goal:progress", goal);
  });

  // Supervision events — broadcast to dashboard for observability
  eventBus.on("supervision:auto-continue", (sessionId, questionText) => {
    broadcast("supervision:action", { action: "auto-continue", sessionId, questionText });
  });

  eventBus.on("supervision:goal-injected", (sessionId) => {
    broadcast("supervision:action", { action: "goal-injected", sessionId });
  });

  eventBus.on("supervision:drift-detected", (sessionId, confidence, reason) => {
    broadcast("supervision:action", { action: "drift-detected", sessionId, confidence, reason });
  });

  eventBus.on("supervision:compaction-recovery", (sessionId) => {
    broadcast("supervision:action", { action: "compaction-recovery", sessionId });
  });

  eventBus.on("supervision:auto-retry", (sessionId, attempt) => {
    broadcast("supervision:action", { action: "auto-retry", sessionId, attempt });
  });

  eventBus.on("supervision:auto-advance", (sessionId, nextNodeId) => {
    broadcast("supervision:action", { action: "auto-advance", sessionId, nextNodeId });
  });

  eventBus.on("supervision:escalation", (sessionId, data) => {
    broadcast("supervision:action", { action: "escalation", sessionId, ...data });
  });

  eventBus.on("supervision:human-response", (sessionId, response) => {
    broadcast("supervision:action", { action: "human-response", sessionId, response });
  });

  // Start heartbeat interval for dead client cleanup
  heartbeatInterval = setInterval(() => {
    for (const client of clients) {
      if (aliveMap.get(client) === false) {
        // Client didn't respond to previous ping, terminate
        client.terminate();
        clients.delete(client);
        continue;
      }

      // Mark as not alive, will be set back to true on pong
      aliveMap.set(client, false);
      if (client.readyState === 1) {
        client.ping();
      }
    }
  }, WS_HEARTBEAT_INTERVAL_MS);
}

/**
 * Clean up the heartbeat interval on server shutdown.
 */
export function shutdownHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}
