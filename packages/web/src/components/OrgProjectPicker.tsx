/**
 * Shared org + project selector. Reads/writes ?org=&project= search-params
 * so every brain page shares the same scope without prop-drilling. Replaces
 * the typed-in `org_id` / `project_id` text fields scattered through the
 * brain UI.
 */

import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  fetchOrgs,
  fetchProjects,
  type OrgWithStats,
  type ProjectRow,
} from "../lib/api";

/** Sentinel project id meaning "all projects in this org". Some
 *  surfaces (Brain hub, picker default) treat this as an "no project
 *  picked yet" state and pass `project_id=undefined` to the server. */
export const ORG_LEVEL = "_org_level";

export interface OrgProjectScope {
  orgId: string;
  projectId: string;
}

/**
 * Hook: returns the currently-selected org/project (default: first org +
 * org-level sentinel project). Persists to URL search params so deep links
 * survive nav.
 */
export function useOrgProject(): {
  scope: OrgProjectScope;
  setScope: (next: Partial<OrgProjectScope>) => void;
} {
  const [params, setParams] = useSearchParams();
  // Phase 12 — also accept the legacy `?org_id=` / `?project_id=` query
  // params used by Brain detail-page links so when the user lands on
  // an artifact via an old bookmark, the picker tracks the URL instead
  // of snapping back to the Personal default.
  const orgId =
    params.get("org") ?? params.get("org_id") ?? "org_personal";
  const projectId =
    params.get("project") ?? params.get("project_id") ?? ORG_LEVEL;

  function setScope(next: Partial<OrgProjectScope>) {
    const merged = new URLSearchParams(params);
    if (next.orgId !== undefined) merged.set("org", next.orgId);
    if (next.projectId !== undefined) merged.set("project", next.projectId);
    setParams(merged, { replace: true });
  }

  return { scope: { orgId, projectId }, setScope };
}

export function OrgProjectPicker({
  showOrgLevel = true,
  className = "",
}: {
  /** Include the `_org_level` sentinel in the project list. */
  showOrgLevel?: boolean;
  className?: string;
}): React.ReactElement {
  const { scope, setScope } = useOrgProject();
  const [orgs, setOrgs] = useState<OrgWithStats[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetchOrgs()
      .then((rs) => {
        setOrgs(rs);
        if (!rs.find((o) => o.id === scope.orgId) && rs.length > 0) {
          setScope({ orgId: rs[0].id });
        }
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!scope.orgId) return;
    // BUG FIX: clear stale projects from previous org so a slow fetch
    // can't show Personal's projects under Apply, and use a cancel flag
    // so rapid org-switching races don't write old data over new.
    setProjects([]);
    setErr(null);
    let cancelled = false;
    fetchProjects(scope.orgId)
      .then((ps) => {
        if (cancelled) return;
        setProjects(ps);
        // Phase 12 (UI review M2) — only auto-replace when the current
        // selection is actually invalid (project doesn't exist in this
        // org). Sticky `_org_level` so users can pick the org-wide
        // sentinel and have it stay picked.
        const currentExists =
          scope.projectId === "_org_level" ||
          ps.some((p) => p.id === scope.projectId);
        if (!currentExists && ps.length > 0) {
          setScope({ projectId: ps[0].id });
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.orgId]);

  const orgColor = orgs.find((o) => o.id === scope.orgId)?.color;

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <span
        className="w-2 h-2 rounded-full flex-shrink-0"
        style={{ background: orgColor ?? "#475569" }}
        aria-hidden
      />
      <select
        value={scope.orgId}
        onChange={(e) => setScope({ orgId: e.target.value, projectId: ORG_LEVEL })}
        disabled={loading}
        aria-label="Select organisation"
        className="bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[140px]"
      >
        {orgs.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
        {orgs.length === 0 && <option value={scope.orgId}>{scope.orgId}</option>}
      </select>

      <select
        value={scope.projectId}
        onChange={(e) => setScope({ projectId: e.target.value })}
        disabled={loading || projects.length === 0}
        aria-label="Select project"
        className="bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[180px]"
      >
        {showOrgLevel && (
          <option value={ORG_LEVEL}>— org-level —</option>
        )}
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>

      {err && (
        <span className="text-xs text-red-400" title={err}>
          ⚠ load failed
        </span>
      )}
    </div>
  );
}
