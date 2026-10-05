/**
 * Container for /brain/* pages. Renders one sidebar entry's worth of
 * horizontal sub-tabs and a shared org/project picker. All child pages
 * read scope via useOrgProject() instead of typing IDs themselves.
 */

import { NavLink, Outlet, useLocation } from "react-router-dom";
import { OrgProjectPicker } from "./OrgProjectPicker";

// Phase 12 (UI review H5) — "Hub" replaces the empty force-graph as the
// /brain index; the graph keeps its own dedicated tab.
const TABS = [
  { to: "/brain", end: true, label: "Hub" },
  { to: "/brain/graph", label: "Graph" },
  { to: "/brain/timeline", label: "Timeline" },
  { to: "/brain/search", label: "Search" },
  { to: "/brain/archive", label: "Archive" },
  { to: "/brain/thoughts", label: "Thoughts" },
  { to: "/brain/images", label: "Images" },
  { to: "/brain/code", label: "Code" },
  { to: "/brain/compare", label: "Compare" },
  { to: "/brain/bookmarklet", label: "Capture" },
];

export function BrainLayout(): React.ReactElement {
  const loc = useLocation();
  void loc;
  // Phase 12 (UI review M1) — picker is shared across every brain tab,
  // including bookmarklet. The bookmarklet page now reads useOrgProject()
  // and only owns its own server-URL + API-key + mode controls.
  const showPicker = true;

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center gap-4 px-5 py-3 border-b border-slate-800 bg-slate-900 flex-wrap">
        <h2 className="text-base font-bold text-white">Brain</h2>
        <nav className="flex items-center gap-1 flex-wrap">
          {TABS.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              className={({ isActive }) =>
                `px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                  isActive
                    ? "bg-slate-800 text-white"
                    : "text-slate-400 hover:text-white hover:bg-slate-800/50"
                }`
              }
            >
              {t.label}
            </NavLink>
          ))}
        </nav>
        {showPicker && (
          <div className="ml-auto">
            <OrgProjectPicker />
          </div>
        )}
      </header>
      <div className="flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}

/** Same shell for /admin/brain/* pages — different tab set. */
const ADMIN_TABS = [
  { to: "/admin/brain", end: true, label: "Dashboard" },
  { to: "/admin/brain/metrics", label: "Metrics" },
  { to: "/admin/brain/events", label: "Events" },
  { to: "/admin/brain/query-logs", label: "Query Logs" },
  { to: "/admin/brain/extractors", label: "Extractors" },
  { to: "/admin/brain/suggestions", label: "Suggestions" },
  { to: "/admin/brain/merge-queue", label: "Merge Queue" },
  { to: "/admin/brain/config", label: "Config" },
];

export function BrainAdminLayout(): React.ReactElement {
  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center gap-4 px-5 py-3 border-b border-slate-800 bg-slate-900 flex-wrap">
        <h2 className="text-base font-bold text-white">Brain · Admin</h2>
        <nav className="flex items-center gap-1 flex-wrap">
          {ADMIN_TABS.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              className={({ isActive }) =>
                `px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                  isActive
                    ? "bg-slate-800 text-white"
                    : "text-slate-400 hover:text-white hover:bg-slate-800/50"
                }`
              }
            >
              {t.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto">
          <OrgProjectPicker />
        </div>
      </header>
      <div className="flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}
