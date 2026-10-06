import { useCallback, useEffect, useState } from "react";
import { listOrgs } from "../services/api";
import { getOrgs, subscribeOrgs, type OrgInfo } from "../services/orgs";

/**
 * Live org list (user-defined, from GET /api/orgs). Loads on mount and
 * re-renders whenever any screen refreshes orgs. `reload` is for
 * pull-to-refresh.
 */
export function useOrgs(): { orgs: readonly OrgInfo[]; reload: () => Promise<void> } {
  const [orgs, setLocal] = useState<readonly OrgInfo[]>(getOrgs());

  const reload = useCallback(async () => {
    try {
      await listOrgs();
    } catch {
      // keep the last known list; fetchJson already reports the failure
    }
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeOrgs(setLocal);
    void reload();
    return unsubscribe;
  }, [reload]);

  return { orgs, reload };
}

/**
 * Subscribe to the org registry WITHOUT fetching — for leaf components
 * (badges, chips) so a list of 50 badges doesn't fire 50 requests.
 */
export function useOrgRegistry(): readonly OrgInfo[] {
  const [orgs, setLocal] = useState<readonly OrgInfo[]>(getOrgs());
  useEffect(() => subscribeOrgs(setLocal), []);
  return orgs;
}
