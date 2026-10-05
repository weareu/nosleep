import { getServerConfig } from "../config";
import type { WsEvent, WsEventType } from "../types";

type Listener = (event: WsEvent) => void;
type ConnectionListener = (connected: boolean) => void;

interface WsManager {
  connect: () => void;
  disconnect: () => void;
  subscribe: (type: WsEventType | "*", listener: Listener) => () => void;
  onConnectionChange: (listener: ConnectionListener) => () => void;
  isConnected: () => boolean;
}

// Reconnect backoff: 3s, 6s, 12s, 24s, capped at 30s, plus jitter. Reset to
// the base delay on a successful open. The old fixed 3s timer hammered a
// restarting server every 3s indefinitely.
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 30000;

export function createWsManager(): WsManager {
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let intentionalClose = false;
  const listeners = new Map<string, Set<Listener>>();
  const connectionListeners = new Set<ConnectionListener>();

  function notifyConnectionChange(connected: boolean): void {
    connectionListeners.forEach((fn) => fn(connected));
  }

  function emit(event: WsEvent): void {
    // Notify type-specific listeners
    const typeListeners = listeners.get(event.type);
    if (typeListeners) {
      typeListeners.forEach((fn) => fn(event));
    }
    // Notify wildcard listeners
    const wildcardListeners = listeners.get("*");
    if (wildcardListeners) {
      wildcardListeners.forEach((fn) => fn(event));
    }
  }

  function scheduleReconnect(): void {
    if (intentionalClose) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempts);
    const jitter = Math.floor(Math.random() * 1000);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      connect();
    }, backoff + jitter);
  }

  function connect(): void {
    intentionalClose = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // Close any prior socket before opening a new one — otherwise a redundant
    // connect() (App + TabNavigator + AppState all call it) orphans the old
    // WebSocket, leaking it until GC.
    if (ws) {
      try {
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.onopen = null;
        ws.close();
      } catch {
        // already closing/closed
      }
      ws = null;
    }

    getServerConfig()
      .then(({ wsUrl }) => {
        if (!wsUrl) {
          // Discovery hasn't found a server — back off and retry rather than
          // opening a WebSocket to an empty URL.
          scheduleReconnect();
          return;
        }
        try {
          ws = new WebSocket(wsUrl);

          ws.onopen = () => {
            reconnectAttempts = 0; // healthy — reset backoff
            notifyConnectionChange(true);
          };

          ws.onmessage = (event: WebSocketMessageEvent) => {
            try {
              const parsed = JSON.parse(event.data as string) as WsEvent;
              emit(parsed);
            } catch {
              // Ignore malformed messages
            }
          };

          ws.onerror = () => {
            // Error will trigger onclose
          };

          ws.onclose = () => {
            ws = null;
            notifyConnectionChange(false);
            scheduleReconnect();
          };
        } catch {
          scheduleReconnect();
        }
      })
      .catch(() => {
        scheduleReconnect();
      });
  }

  function disconnect(): void {
    intentionalClose = true;
    reconnectAttempts = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      // onclose handler will call notifyConnectionChange(false)
      ws.close();
      ws = null;
    } else {
      notifyConnectionChange(false);
    }
  }

  function subscribe(
    type: WsEventType | "*",
    listener: Listener
  ): () => void {
    if (!listeners.has(type)) {
      listeners.set(type, new Set());
    }
    listeners.get(type)!.add(listener);

    return () => {
      const set = listeners.get(type);
      if (set) {
        set.delete(listener);
        if (set.size === 0) {
          listeners.delete(type);
        }
      }
    };
  }

  function onConnectionChange(listener: ConnectionListener): () => void {
    connectionListeners.add(listener);
    return () => {
      connectionListeners.delete(listener);
    };
  }

  function isConnected(): boolean {
    return ws !== null && ws.readyState === WebSocket.OPEN;
  }

  return { connect, disconnect, subscribe, onConnectionChange, isConnected };
}

// Singleton instance
export const wsManager = createWsManager();
