import { useState, useCallback } from "react";

export function useRefresh(
  onRefresh: () => Promise<void>
): { refreshing: boolean; handleRefresh: () => void } {
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    onRefresh().finally(() => setRefreshing(false));
  }, [onRefresh]);

  return { refreshing, handleRefresh };
}
