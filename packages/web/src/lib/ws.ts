import type { WsEvent, WsEventType } from "@nosleep/shared";

type WsListener = (event: WsEvent) => void;

const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

export class WsClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<WsListener>();
  private reconnectMs = INITIAL_RECONNECT_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;
  private url: string;

  constructor() {
    const apiKey = import.meta.env.VITE_API_KEY ?? "";
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const tokenParam = apiKey ? `?token=${apiKey}` : "";
    this.url = `${proto}//${window.location.host}/ws${tokenParam}`;
  }

  get connected(): boolean {
    return this._connected;
  }

  connect(): void {
    if (this.ws) return;

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this._connected = true;
        this.reconnectMs = INITIAL_RECONNECT_MS;
        this.notify({ type: "session:update" as WsEventType, data: { connected: true }, timestamp: new Date().toISOString() });
      };

      this.ws.onclose = () => {
        this._connected = false;
        this.ws = null;
        this.notify({ type: "session:update" as WsEventType, data: { connected: false }, timestamp: new Date().toISOString() });
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.ws?.close();
      };

      this.ws.onmessage = (evt: MessageEvent) => {
        try {
          const parsed = JSON.parse(evt.data as string) as WsEvent;
          this.notify(parsed);
        } catch {
          // ignore malformed messages
        }
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this._connected = false;
  }

  subscribe(listener: WsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(event: WsEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectMs = Math.min(this.reconnectMs * 2, MAX_RECONNECT_MS);
      this.connect();
    }, this.reconnectMs);
  }
}

// Singleton instance
export const wsClient = new WsClient();
