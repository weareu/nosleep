import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { fetchAlerts, fetchAlertsCount, type AlertRow } from "../lib/api";
import { useWebSocket } from "./useWebSocket";

/**
 * Fetches a list of alerts. Used by the Dashboard's "Recent Alerts"
 * sidebar — capped at the server's default limit, which is fine for
 * a recent-list. Anything that needs the *count* should use the
 * dedicated useAlertsCount hook so the value is accurate even past
 * the list-endpoint limit.
 */
export function useAlerts(orgId?: string, unackedOnly?: boolean) {
  const queryClient = useQueryClient();
  const { lastEvent } = useWebSocket(["alert:new", "alert:ack", "alert:unack"]);

  const query = useQuery<AlertRow[]>({
    queryKey: ["alerts", orgId, unackedOnly],
    queryFn: () => fetchAlerts({ orgId, unackedOnly }),
  });

  useEffect(() => {
    if (
      lastEvent?.type === "alert:new" ||
      lastEvent?.type === "alert:ack" ||
      lastEvent?.type === "alert:unack"
    ) {
      queryClient.invalidateQueries({ queryKey: ["alerts"] });
      queryClient.invalidateQueries({ queryKey: ["alerts-count"] });
    }
  }, [lastEvent, queryClient]);

  // Defensive fallback for callers using the legacy `unackedCount` —
  // it counts what came back, capped at the server limit. The sidebar
  // badge uses useAlertsCount() instead, which is uncapped.
  const unackedCount = useMemo(
    () => query.data?.filter((a) => !a.acknowledged).length ?? 0,
    [query.data],
  );

  return { ...query, unackedCount };
}

/**
 * Returns just the count of alerts matching the filter set. Powers the
 * sidebar badge — uses the cheap /api/alerts/count endpoint so the
 * displayed value stays accurate even when the list endpoint truncates.
 */
export function useAlertsCount(orgId?: string, unackedOnly?: boolean) {
  const queryClient = useQueryClient();
  const { lastEvent } = useWebSocket(["alert:new", "alert:ack", "alert:unack"]);

  const query = useQuery<number>({
    queryKey: ["alerts-count", orgId, unackedOnly],
    queryFn: () => fetchAlertsCount({ orgId, unackedOnly }),
  });

  useEffect(() => {
    if (
      lastEvent?.type === "alert:new" ||
      lastEvent?.type === "alert:ack" ||
      lastEvent?.type === "alert:unack"
    ) {
      queryClient.invalidateQueries({ queryKey: ["alerts-count"] });
    }
  }, [lastEvent, queryClient]);

  return { ...query, count: query.data ?? 0 };
}
