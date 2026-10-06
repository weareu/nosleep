import { useEffect } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAlertsCount } from "../hooks/useAlerts";
import { useWebSocket } from "../hooks/useWebSocket";
import { ErrorBoundary } from "./ErrorBoundary";
import { useToasts, ToastStack } from "./Toast";

interface NavItem {
  to: string;
  label: string;
  icon: () => React.ReactElement;
}

interface NavSection {
  heading: string;
  items: NavItem[];
}

// Phase 12 (UI review H5) — grouped sidebar so the 9-entry flat list isn't a
// memorisation game; Brain Admin gets a distinct icon to stop reading as a
// duplicate of Brain.
const NAV_SECTIONS: NavSection[] = [
  {
    heading: "Operations",
    items: [
      { to: "/", label: "Dashboard", icon: DashboardIcon },
      { to: "/projects", label: "Projects", icon: ProjectsIcon },
      { to: "/strategy", label: "Strategy", icon: StrategyIcon },
      { to: "/coordination", label: "Coordination", icon: CoordinationIcon },
      { to: "/alerts", label: "Alerts", icon: AlertsIcon },
    ],
  },
  {
    heading: "Brain",
    items: [
      { to: "/brain", label: "Brain", icon: BrainIcon },
      { to: "/admin/brain", label: "Admin", icon: BrainAdminIcon },
    ],
  },
  {
    heading: "Telemetry",
    items: [
      { to: "/tokens", label: "Token Usage", icon: TokensIcon },
      { to: "/metrics", label: "Metrics", icon: MetricsIcon },
    ],
  },
  {
    heading: "System",
    items: [{ to: "/settings", label: "Settings", icon: SettingsIcon }],
  },
];

export function Layout(): React.ReactElement {
  const { connected, lastEvent } = useWebSocket(["alert:new"]);
  const { count: unackedCount } = useAlertsCount(undefined, true);
  const { toasts, push, dismiss } = useToasts();

  // Phase 12 (UI review #2 — M1) — surface live alerts as a transient toast
  // so users on a non-Alerts tab don't miss them. The sidebar badge still
  // bumps in parallel via useAlerts → useQuery invalidation.
  useEffect(() => {
    if (lastEvent?.type !== "alert:new") return;
    const data = lastEvent.data as
      | { message?: string; type?: string; severity?: string }
      | undefined;
    push({
      kind: data?.severity === "critical" ? "error" : "info",
      message: `New alert: ${data?.type ?? "unknown"}`,
      detail: data?.message ?? undefined,
    });
  }, [lastEvent, push]);

  return (
    <div className="flex h-screen bg-slate-900">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 border-r border-slate-800 flex flex-col">
        <div className="px-5 py-5 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-sm font-bold">
              NS
            </div>
            <div>
              <h1 className="text-base font-bold text-white tracking-tight">NoSleep</h1>
              <p className="text-[10px] text-slate-500 uppercase tracking-widest">Command Center</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-3 py-3 overflow-y-auto">
          {NAV_SECTIONS.map((section) => (
            <div key={section.heading} className="mb-4">
              <div className="px-3 py-1 text-[10px] uppercase tracking-widest text-slate-600 font-semibold">
                {section.heading}
              </div>
              <div className="space-y-0.5 mt-1">
                {section.items.map(({ to, label, icon: Icon }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={to === "/"}
                    className={({ isActive }) =>
                      `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                        isActive
                          ? "bg-slate-800 text-white"
                          : "text-slate-400 hover:text-white hover:bg-slate-800/50"
                      }`
                    }
                  >
                    <Icon />
                    <span>{label}</span>
                    {label === "Alerts" && unackedCount > 0 && (
                      <span className="ml-auto bg-red-500 text-white text-[10px] font-bold rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center">
                        {unackedCount > 99 ? "99+" : unackedCount}
                      </span>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {/* Connection status */}
        <div className="px-5 py-3 border-t border-slate-800">
          <div className="flex items-center gap-2 text-xs">
            <span
              className={`w-2 h-2 rounded-full ${
                connected ? "bg-green-500" : "bg-red-500 animate-pulse"
              }`}
            />
            <span className={connected ? "text-slate-400" : "text-red-400"}>
              {connected ? "Connected" : "Disconnected"}
            </span>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <ErrorBoundary scope="dashboard">
          <Outlet />
        </ErrorBoundary>
      </main>
      <ToastStack toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

// --- Nav Icons (inline SVG components) ---

function DashboardIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
    </svg>
  );
}

function ProjectsIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
    </svg>
  );
}

function AlertsIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
    </svg>
  );
}

function StrategyIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
    </svg>
  );
}

function CoordinationIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  );
}

function TokensIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function MetricsIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z" />
    </svg>
  );
}

function BrainIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 3A3 3 0 006.75 6v.25a3.75 3.75 0 00-1.5 7.125V15a3 3 0 003 3h.75v.75A2.25 2.25 0 0011.25 21h1.5a2.25 2.25 0 002.25-2.25V18h.75a3 3 0 003-3v-1.625a3.75 3.75 0 00-1.5-7.125V6A3 3 0 0014.25 3h-4.5z" />
    </svg>
  );
}

// Phase 12 (UI review H5) — wrench/gear-on-shield icon for the admin
// surface, so it doesn't read as a duplicate of the Brain entry above.
function BrainAdminIcon() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.42 15.17 17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437 1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z" />
    </svg>
  );
}
