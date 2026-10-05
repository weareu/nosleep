import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { humanizeApiError } from "../../../lib/humanize-error";
import { brainAdminEvents } from "../../../lib/brainApi";
import { useOrgProject } from "../../../components/OrgProjectPicker";

const HASH_COLS = new Set([
  "hash",
  "artifact_hash",
  "from_hash",
  "to_hash",
  "sample_hash",
]);
const SESSION_COLS = new Set(["session_id"]);

const TABLES = [
  "ingest_events",
  "extractor_runs",
  "hook_fires",
  "brain_session_events",
] as const;

type TableName = (typeof TABLES)[number];

export function BrainAdminEvents(): React.ReactElement {
  const { scope } = useOrgProject();
  const orgId = scope.orgId;
  const [table, setTable] = useState<TableName>("ingest_events");
  const [resultFilter, setResultFilter] = useState<string>("");
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Phase 12 (UI review #2 — H4) — expand state for click-to-reveal payload.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await brainAdminEvents({
        org_id: orgId,
        table,
        result: resultFilter || undefined,
        limit: 200,
      });
      setItems(r.items);
    } catch (e) {
      setErr(humanizeApiError(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, table, resultFilter]);

  const cols =
    items.length > 0
      ? Object.keys(items[0]).filter(
          (k) => k !== "payload_json" && k !== "enqueued_json" && k !== "tags_json",
        )
      : [];

  return (
    <div className="p-6 space-y-4 text-slate-200">
      <h1 className="text-2xl font-bold">Events</h1>
      <div className="flex gap-3 items-end">
        <label>
          <div className="text-xs uppercase text-slate-400 mb-1">Table</div>
          <select
            value={table}
            onChange={(e) => setTable(e.target.value as TableName)}
            className="bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm"
          >
            {TABLES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        {table === "extractor_runs" && (
          <label>
            <div className="text-xs uppercase text-slate-400 mb-1">Result</div>
            <select
              value={resultFilter}
              onChange={(e) => setResultFilter(e.target.value)}
              className="bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm"
            >
              <option value="">(all)</option>
              <option value="success">success</option>
              <option value="failed">failed</option>
              <option value="skipped">skipped</option>
            </select>
          </label>
        )}
      </div>

      {err && (
        <div role="alert" className="text-red-400 bg-red-950/30 border border-red-900 p-3 rounded text-sm">
          {err}
        </div>
      )}

      {loading ? (
        <TableSkeleton rows={6} />
      ) : items.length > 0 ? (
        <div className="overflow-x-auto bg-slate-800/40 border border-slate-800 rounded">
          <table className="text-xs w-full">
            <thead className="text-left text-slate-500 uppercase tracking-wide border-b border-slate-700">
              <tr>
                <th className="w-6 px-2 py-2 font-normal" aria-label="expand" />
                {cols.map((c) => (
                  <th key={c} className="px-2 py-2 font-normal">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((row, i) => {
                const id =
                  (row as { event_id?: string; run_id?: string; fire_id?: string })
                    .event_id ??
                  (row as { run_id?: string }).run_id ??
                  (row as { fire_id?: string }).fire_id ??
                  String(i);
                const isExpanded = expandedId === id;
                return (
                  <EventRow
                    key={id}
                    row={row}
                    cols={cols}
                    orgId={orgId}
                    isExpanded={isExpanded}
                    onToggle={() => setExpandedId(isExpanded ? null : id)}
                    table={table}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-slate-500 text-sm">no rows</div>
      )}
    </div>
  );
}

const HIDDEN_PAYLOAD_COLS = ["payload_json", "enqueued_json", "tags_json"];

function EventRow({
  row,
  cols,
  orgId,
  isExpanded,
  onToggle,
  table,
}: {
  row: Record<string, unknown>;
  cols: string[];
  orgId: string;
  isExpanded: boolean;
  onToggle: () => void;
  table: string;
}): React.ReactElement {
  const payloadCols = HIDDEN_PAYLOAD_COLS.filter(
    (c) => row[c] !== undefined && row[c] !== null,
  );
  const hasPayload = payloadCols.length > 0;
  return (
    <>
      <tr className="border-b border-slate-800/50 hover:bg-slate-800/30">
        <td className="px-2 py-1 align-top">
          {hasPayload ? (
            <button
              type="button"
              onClick={onToggle}
              aria-label={isExpanded ? "Collapse row" : "Expand row payload"}
              aria-expanded={isExpanded}
              className="text-slate-500 hover:text-slate-200 font-mono"
            >
              {isExpanded ? "▾" : "▸"}
            </button>
          ) : (
            <span className="text-slate-700">·</span>
          )}
        </td>
        {cols.map((c) => {
          const v = row[c];
          return (
            <td key={c} className="px-2 py-1 align-top whitespace-nowrap">
              {renderCell(c, v, orgId)}
            </td>
          );
        })}
      </tr>
      {isExpanded && hasPayload && (
        <tr className="bg-slate-900/40 border-b border-slate-800/50">
          <td colSpan={cols.length + 1} className="px-4 py-3">
            <ExpandedPayload row={row} cols={payloadCols} table={table} />
          </td>
        </tr>
      )}
    </>
  );
}

function ExpandedPayload({
  row,
  cols,
  table,
}: {
  row: Record<string, unknown>;
  cols: string[];
  table: string;
}): React.ReactElement {
  return (
    <div className="space-y-3 max-w-full">
      {cols.map((c) => {
        const raw = row[c];
        let pretty: string;
        try {
          pretty =
            typeof raw === "string"
              ? JSON.stringify(JSON.parse(raw), null, 2)
              : JSON.stringify(raw, null, 2);
        } catch {
          pretty = String(raw);
        }
        return (
          <div key={c}>
            <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
              {c}
            </div>
            <pre className="text-[11px] text-slate-300 bg-slate-950/60 border border-slate-800 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words max-h-72">
              {pretty}
            </pre>
          </div>
        );
      })}
      {table === "extractor_runs" && typeof row.artifact_hash === "string" && (
        <div className="text-[11px] text-slate-500">
          Tip: re-run extractors by re-ingesting the artifact via{" "}
          <code className="bg-slate-900 px-1 rounded">POST /api/brain/ingest</code>{" "}
          with the same content — the pipeline re-fans the extractor queue.
        </div>
      )}
    </div>
  );
}

function TableSkeleton({ rows }: { rows: number }): React.ReactElement {
  return (
    <div
      className="bg-slate-800/40 border border-slate-800 rounded p-2 space-y-1"
      role="status"
      aria-label="Loading events"
    >
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-4 rounded bg-slate-800/80 animate-pulse"
          style={{ width: `${50 + ((i * 7) % 50)}%` }}
        />
      ))}
    </div>
  );
}

function renderCell(
  col: string,
  v: unknown,
  orgId: string,
): React.ReactNode {
  if (v === null || v === undefined) return "—";

  // Hash columns → link to /brain/artifact/:hash
  if (HASH_COLS.has(col) && typeof v === "string" && /^[0-9a-f]{64}$/.test(v)) {
    return (
      <Link
        to={`/brain/artifact/${v}?org_id=${orgId}`}
        className="font-mono text-blue-400 hover:underline"
        title={v}
      >
        {v.slice(0, 12)}…
      </Link>
    );
  }
  // Session columns → link to /brain/session/:id
  if (SESSION_COLS.has(col) && typeof v === "string" && v.length > 0) {
    return (
      <Link
        to={`/brain/session/${v}?org_id=${orgId}`}
        className="font-mono text-blue-400 hover:underline"
        title={v}
      >
        {v.slice(0, 12)}…
      </Link>
    );
  }
  if (col === "ts" || col === "created_at" || col.endsWith("_ts") || col === "verified_at") {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return new Date(n * 1000).toLocaleString();
  }
  if (typeof v === "string" && v.length > 60) return v.slice(0, 60) + "…";
  return String(v);
}
