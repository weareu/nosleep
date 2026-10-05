import { useEffect, useRef, useState, useCallback } from "react";
import type { WsEvent, WsEventType } from "@nosleep/shared";
import { wsClient } from "../lib/ws";

interface UseWebSocketReturn {
  readonly connected: boolean;
  readonly lastEvent: WsEvent | null;
  readonly events: readonly WsEvent[];
}

const MAX_EVENTS = 200;

export function useWebSocket(
  filterTypes?: readonly WsEventType[],
): UseWebSocketReturn {
  const [connected, setConnected] = useState(wsClient.connected);
  const [lastEvent, setLastEvent] = useState<WsEvent | null>(null);
  const [events, setEvents] = useState<readonly WsEvent[]>([]);
  const filterRef = useRef(filterTypes);
  filterRef.current = filterTypes;

  const handleEvent = useCallback((event: WsEvent) => {
    // Track connection status
    if (event.data && typeof event.data === "object" && "connected" in event.data) {
      setConnected(event.data.connected as boolean);
    }

    // Filter by type if specified
    if (filterRef.current && !filterRef.current.includes(event.type)) {
      return;
    }

    setLastEvent(event);
    setEvents((prev) => {
      const next = [event, ...prev];
      return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next;
    });
  }, []);

  useEffect(() => {
    wsClient.connect();
    const unsubscribe = wsClient.subscribe(handleEvent);
    return unsubscribe;
  }, [handleEvent]);

  return { connected, lastEvent, events };
}
