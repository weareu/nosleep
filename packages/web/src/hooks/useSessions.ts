import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { fetchSessions, type SessionRow } from "../lib/api";
import { useWebSocket } from "./useWebSocket";

export function useSessions(orgId?: string, status?: string) {
  const queryClient = useQueryClient();
  const { lastEvent } = useWebSocket(["session:update"]);

  const query = useQuery<SessionRow[]>({
    queryKey: ["sessions", orgId, status],
    queryFn: () => fetchSessions(orgId, status),
  });

  // Invalidate sessions cache on WS session updates
  useEffect(() => {
    if (lastEvent?.type === "session:update") {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    }
  }, [lastEvent, queryClient]);

  return query;
}
