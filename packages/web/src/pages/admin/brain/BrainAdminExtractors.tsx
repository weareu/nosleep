import { useEffect, useState } from "react";
import { humanizeApiError } from "../../../lib/humanize-error";
import {
  brainAdminExtractors,
  type BrainExtractorHealth,
} from "../../../lib/brainApi";
import { useOrgProject } from "../../../components/OrgProjectPicker";

const WINDOWS = [
  { label: "1h", h: 1 },
  { label: "24h", h: 24 },
  { label: "7d", h: 24 * 7 },
  { label: "30d", h: 24 * 30 },
];

export function BrainAdminExtractors(): React.ReactElement {
  const { scope } = useOrgProject();
  const orgId = scope.orgId;
  const [windowIdx, setWindowIdx] = useState(1);
  const [items, setItems] = useState<BrainExtractorHealth[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await brainAdminExtractors({
        org_id: orgId,
        since_hours: WINDOWS[windowIdx].h,
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
  }, [orgId, windowIdx]);

  return (
    <div className="p-6 space-y-4 text-slate-200">
      <h1 className="text-2xl font-bold">Extractor Health</h1>
      <div className="flex gap-2">
        {WINDOWS.map((w, i) => (
          <button
            key={w.label}
            type="button"
            onClick={() => setWindowIdx(i)}
            className={`px-3 py-1.5 text-xs rounded border ${
              windowIdx === i
                ? "bg-blue-600 border-blue-500 text-white"
                : "bg-slate-800 border-slate-700 text-slate-300"
            }`}
          >
            {w.label}
          </button>
        ))}
      </div>

      {err && (
        <div role="alert" className="text-red-400 bg-red-950/30 border border-red-900 p-3 rounded text-sm">
          {err}
        </div>
      )}

      {loading ? (
        <div className="text-slate-500 text-sm">loading…</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((e) => {
            const failureRate = e.total > 0 ? (e.failed / e.total) * 100 : 0;
            const successRate = e.total > 0 ? (e.success / e.total) * 100 : 0;
            return (
              <div
                key={e.extractor}
                className="bg-slate-800/40 border border-slate-800 rounded-lg p-4"
              >
                <div className="flex justify-between items-baseline mb-2">
                  <h3 className="font-mono text-sm">{e.extractor}</h3>
                  <span className="text-xs text-slate-500">{e.total} runs</span>
                </div>
                <div className="space-y-1 text-xs">
                  <Row label="success" value={`${e.success} (${successRate.toFixed(1)}%)`} colour="emerald" />
                  <Row
                    label="failed"
                    value={`${e.failed} (${failureRate.toFixed(1)}%)`}
                    colour={e.failed > 0 ? "red" : "slate"}
                  />
                  <Row label="skipped" value={String(e.skipped)} colour="slate" />
                  <Row label="avg ms" value={(e.avg_ms ?? 0).toFixed(0)} />
                  <Row label="max ms" value={(e.max_ms ?? 0).toFixed(0)} />
                  <Row
                    label="last run"
                    value={
                      e.last_run
                        ? new Date(e.last_run * 1000).toLocaleString()
                        : "—"
                    }
                  />
                </div>
              </div>
            );
          })}
          {!items.length && (
            <div className="text-slate-500 text-sm col-span-full">no extractor runs in window</div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  colour,
}: {
  label: string;
  value: string;
  colour?: "emerald" | "red" | "slate";
}): React.ReactElement {
  const colourMap: Record<string, string> = {
    emerald: "text-emerald-400",
    red: "text-red-400",
    slate: "text-slate-400",
  };
  return (
    <div className="flex justify-between">
      <span className="text-slate-500">{label}</span>
      <span className={colour ? colourMap[colour] : "text-slate-200"}>
        {value}
      </span>
    </div>
  );
}
