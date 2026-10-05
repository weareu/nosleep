import { useEffect } from "react";
import { wsManager } from "../services/ws";
import type { WsEvent, WsEventType } from "../types";

export function useWsEvent(
  type: WsEventType | "*",
  handler: (event: WsEvent) => void
): void {
  useEffect(() => {
    const unsubscribe = wsManager.subscribe(type, handler);
    return unsubscribe;
  }, [type, handler]);
}
