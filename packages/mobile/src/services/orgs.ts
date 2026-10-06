/**
 * Org registry — orgs are user-defined on the server, so the app never
 * hard-codes names or colours. This module holds the last list fetched from
 * GET /api/orgs (the server always returns a resolved `color`) and lets
 * screens subscribe to changes. Kept free of react-native imports so the
 * logic is unit-testable.
 */

export interface OrgInfo {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly color: string;
}

type Listener = (orgs: readonly OrgInfo[]) => void;

/** Neutral colour for an org we don't know yet (before the first load). */
export const UNKNOWN_ORG_COLOR = "#64748b"; // slate-500 (theme textMuted)

let orgs: readonly OrgInfo[] = [];
let byId = new Map<string, OrgInfo>();
const listeners = new Set<Listener>();

export function setOrgs(next: readonly OrgInfo[]): void {
  orgs = next.map((o) => ({ id: o.id, name: o.name, slug: o.slug, color: o.color }));
  byId = new Map(orgs.map((o) => [o.id, o]));
  for (const l of listeners) l(orgs);
}

export function getOrgs(): readonly OrgInfo[] {
  return orgs;
}

export function subscribeOrgs(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function orgColor(orgId: string | null | undefined): string {
  return (orgId && byId.get(orgId)?.color) || UNKNOWN_ORG_COLOR;
}

export function orgName(orgId: string | null | undefined): string {
  if (!orgId) return "";
  return byId.get(orgId)?.name ?? orgId;
}

/**
 * Fetch orgs via the given loader and publish them. Errors leave the
 * previous list in place and are rethrown for the caller to surface.
 */
export async function loadOrgs(fetcher: () => Promise<readonly OrgInfo[]>): Promise<readonly OrgInfo[]> {
  const next = await fetcher();
  setOrgs(next);
  return orgs;
}
