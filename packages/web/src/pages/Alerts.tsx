import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchOrgs,
  fetchAlerts,
  fetchAlertsCount,
  ackAlert,
  unackAlert,
  ackAllAlerts,
  type OrgWithStats,
  type AlertRow,
} from "../lib/api";
import { AlertItem } from "../components/AlertItem";
import { useWebSocket } from "../hooks/useWebSocket";
import { useToasts, ToastStack } from "../components/Toast";

type FilterType = string | "all";
type FilterSeverity = string | "all";

const PAGE_SIZE = 25;
const SEVERITY_ORDER: ReadonlyArray<"critical" | "warning" | "info"> = [
  "critical",
  "warning",
  "info",
];

const SEVERITY_TONE: Record<string, string> = {
  critical: "text-red-400 bg-red-500/10",
  warning: "text-yellow-400 bg-yellow-500/10",
  info: "text-blue-400 bg-blue-500/10",
};

export function Alerts(): React.ReactElement {
  const queryClient = useQueryClient();
  const [selectedOrg, setSelectedOrg] = useState<string | undefined>(undefined);
  const [filterType, setFilterType] = useState<FilterType>("all");
  const [filterSeverity, setFilterSeverity] = useState<FilterSeverity>("all");
  const [page, setPage] = useState(0);
  const { lastEvent } = useWebSocket(["alert:new", "alert:ack", "alert:unack"]);
  const { toasts, push, dismiss } = useToasts();

  const { data: orgs } = useQuery<OrgWithStats[]>({
    queryKey: ["orgs"],
    queryFn: fetchOrgs,
  });

  // Resolved server-side filter object — derived once per render so
  // both the page query and the count query stay in sync.
  const filters = useMemo(
    () => ({
      orgId: selectedOrg,
      type: filterType !== "all" ? filterType : undefined,
      severity: filterSeverity !== "all" ? filterSeverity : undefined,
    }),
    [selectedOrg, filterType, filterSeverity],
  );

  const { data: pageItems, isLoading } = useQuery<AlertRow[]>({
    queryKey: ["alerts-page", filters, page],
    queryFn: () =>
      fetchAlerts({
        ...filters,
        offset: page * PAGE_SIZE,
        limit: PAGE_SIZE,
      }),
  });

  const { data: totalCount } = useQuery<number>({
    queryKey: ["alerts-page-count", filters],
    queryFn: () => fetchAlertsCount(filters),
  });

  const { data: unackedCount } = useQuery<number>({
    queryKey: ["alerts-unacked-count", filters],
    queryFn: () => fetchAlertsCount({ ...filters, unackedOnly: true }),
  });

  // Re-fetch on WS events. Includes alert:unack so Undo updates land.
  useEffect(() => {
    if (
      lastEvent?.type === "alert:new" ||
      lastEvent?.type === "alert:ack" ||
      lastEvent?.type === "alert:unack"
    ) {
      queryClient.invalidateQueries({ queryKey: ["alerts-page"] });
      queryClient.invalidateQueries({ queryKey: ["alerts-page-count"] });
      queryClient.invalidateQueries({ queryKey: ["alerts-unacked-count"] });
    }
  }, [lastEvent, queryClient]);

  // Reset to page 0 whenever filter set changes so users don't get
  // stranded on a now-out-of-range page.
  useEffect(() => {
    setPage(0);
  }, [selectedOrg, filterType, filterSeverity]);

  const total = totalCount ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safeItems = pageItems ?? [];

  // Bucket the page slice by severity. With server-side severity filter
  // doing the heavy lifting, the in-page grouping just visually
  // separates the page contents — never hides anything.
  const grouped = useMemo(() => {
    const map = new Map<string, AlertRow[]>();
    for (const a of safeItems) {
      const key = SEVERITY_ORDER.includes(a.severity as never) ? a.severity : "info";
      const arr = map.get(key) ?? [];
      arr.push(a);
      map.set(key, arr);
    }
    return SEVERITY_ORDER.map((sev) => ({ severity: sev, items: map.get(sev) ?? [] })).filter(
      (g) => g.items.length > 0,
    );
  }, [safeItems]);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["alerts-page"] });
    queryClient.invalidateQueries({ queryKey: ["alerts-page-count"] });
    queryClient.invalidateQueries({ queryKey: ["alerts-unacked-count"] });
    queryClient.invalidateQueries({ queryKey: ["alerts-count"] });
  };

  const handleAck = async (id: number) => {
    const target = safeItems.find((a) => a.id === id);
    try {
      await ackAlert(id);
    } catch (e) {
      push({
        kind: "error",
        message: "Couldn't acknowledge alert",
        detail: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    invalidateAll();
    push({
      kind: "success",
      message: "Alert acknowledged",
      detail: target?.message,
      undo: async () => {
        try {
          await unackAlert(id);
          invalidateAll();
        } catch (e) {
          push({
            kind: "error",
            message: "Undo failed",
            detail: e instanceof Error ? e.message : String(e),
          });
        }
      },
    });
  };

  const handleAckAll = async (orgId?: string) => {
    const scope = orgId
      ? `org "${orgs?.find((o) => o.id === orgId)?.name ?? orgId}"`
      : "ALL orgs";
    const ok = window.confirm(
      `Acknowledge every unacknowledged alert in ${scope}? This cannot be undone.`,
    );
    if (!ok) return;
    try {
      await ackAllAlerts(orgId);
    } catch (e) {
      push({
        kind: "error",
        message: "Couldn't acknowledge all",
        detail: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    invalidateAll();
    push({ kind: "success", message: `Acknowledged all alerts in ${scope}` });
  };

  const alertTypes = [
    "drift",
    "idle",
    "question",
    "budget_warning",
    "budget_critical",
    "validation_failed",
    "session_error",
    "session_complete",
  ];

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white">Alerts</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {total.toLocaleString()} alerts
            {(unackedCount ?? 0) > 0 && (
              <span className="text-red-400 ml-2">
                ({unackedCount?.toLocaleString()} unacknowledged)
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {selectedOrg && (
            <button
              onClick={() => handleAckAll(selectedOrg)}
              className="px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg transition-colors"
            >
              Ack All (Org)
            </button>
          )}
          <button
            onClick={() => handleAckAll()}
            className="px-3 py-1.5 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg transition-colors"
          >
            Ack All
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4 mb-6">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">Org:</span>
          <div className="flex gap-1">
            <button
              onClick={() => setSelectedOrg(undefined)}
              className={`px-2 py-1 rounded text-xs transition-colors ${
                !selectedOrg ? "bg-slate-700 text-white" : "text-slate-400 hover:text-white"
              }`}
            >
              All
            </button>
            {orgs?.map((org) => (
              <button
                key={org.id}
                onClick={() => setSelectedOrg(org.id === selectedOrg ? undefined : org.id)}
                className={`px-2 py-1 rounded text-xs transition-colors ${
                  selectedOrg === org.id ? "text-white" : "text-slate-400 hover:text-white"
                }`}
                style={selectedOrg === org.id ? { backgroundColor: `${org.color}30` } : undefined}
              >
                {org.name}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">Type:</span>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white focus:outline-none"
          >
            <option value="all">All</option>
            {alertTypes.map((t) => (
              <option key={t} value={t}>
                {t.replace("_", " ")}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">Severity:</span>
          <div className="flex gap-1">
            {["all", "critical", "warning", "info"].map((sev) => (
              <button
                key={sev}
                onClick={() => setFilterSeverity(sev)}
                className={`px-2 py-1 rounded text-xs capitalize transition-colors ${
                  filterSeverity === sev
                    ? "bg-slate-700 text-white"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                {sev}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Alert list */}
      {isLoading ? (
        <div className="text-center py-8 text-slate-500">Loading alerts...</div>
      ) : total === 0 ? (
        <div className="bg-slate-800/30 rounded-xl border border-slate-700/30 p-8 text-center">
          <p className="text-slate-500 text-sm">No alerts match the current filters</p>
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map(({ severity, items }) => (
            <SeverityGroup
              key={severity}
              severity={severity}
              items={items}
              onAck={handleAck}
            />
          ))}

          <Pagination
            page={page}
            totalPages={totalPages}
            totalItems={total}
            pageSize={PAGE_SIZE}
            onPage={setPage}
          />
        </div>
      )}

      <ToastStack toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

function SeverityGroup({
  severity,
  items,
  onAck,
}: {
  severity: string;
  items: AlertRow[];
  onAck: (id: number) => void;
}): React.ReactElement {
  const [collapsed, setCollapsed] = useState(false);
  const tone = SEVERITY_TONE[severity] ?? "text-slate-400 bg-slate-500/10";

  return (
    <section>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className="w-full flex items-center gap-2 mb-2 text-left"
      >
        <span className="text-slate-500 font-mono text-xs w-3">
          {collapsed ? "▸" : "▾"}
        </span>
        <span
          className={`text-[10px] uppercase tracking-widest font-semibold px-2 py-0.5 rounded ${tone}`}
        >
          {severity}
        </span>
        <span className="text-xs text-slate-500">
          {items.length} on this page
        </span>
      </button>
      {!collapsed && (
        <div className="space-y-2">
          {items.map((alert) => (
            <AlertItem key={alert.id} alert={alert} onAck={onAck} />
          ))}
        </div>
      )}
    </section>
  );
}

function Pagination({
  page,
  totalPages,
  totalItems,
  pageSize,
  onPage,
}: {
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPage: (p: number) => void;
}): React.ReactElement | null {
  if (totalPages <= 1) return null;
  const first = page * pageSize + 1;
  const last = Math.min((page + 1) * pageSize, totalItems);
  return (
    <div className="flex items-center justify-between text-xs text-slate-500 pt-2 border-t border-slate-800">
      <div>
        Showing {first.toLocaleString()}–{last.toLocaleString()} of{" "}
        {totalItems.toLocaleString()}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onPage(Math.max(0, page - 1))}
          disabled={page === 0}
          className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-slate-800"
        >
          ← Prev
        </button>
        <span>
          Page {page + 1} / {totalPages}
        </span>
        <button
          type="button"
          onClick={() => onPage(Math.min(totalPages - 1, page + 1))}
          disabled={page >= totalPages - 1}
          className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-slate-800"
        >
          Next →
        </button>
      </div>
    </div>
  );
}
