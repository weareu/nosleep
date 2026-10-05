/**
 * Brain Timeline — chronological view of artifacts in a project, grouped by
 * day with a kind-colour swimlane visualisation.
 *
 * Uses POST /api/brain/search with no text query and a temporal range
 * filter. When `all_time` is checked, fans out across sealed quarters via
 * Phase 9 multi-file fan-out.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { humanizeApiError } from "../../lib/humanize-error";
import {
  brainSearch,
  defaultTemporal,
  type BrainSearchResult,
  type BrainQuerySpec,
} from "../../lib/brainApi";
import { ORG_LEVEL, useOrgProject } from "../../components/OrgProjectPicker";
import { SmartSnippet } from "../../components/SmartSnippet";

const KIND_COLOURS: Record<string, string> = {
  conversation: "#3b82f6",
  code: "#10b981",
  knowledge: "#a855f7",
  decision: "#ef4444",
  image: "#f59e0b",
  artifact: "#64748b",
};

function colourForKind(kind: string): string {
  const top = kind.split("/")[0] ?? "artifact";
  return KIND_COLOURS[top] ?? "#64748b";
}

function dayKey(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function BrainTimeline(): React.ReactElement {
  const [params, setParams] = useSearchParams();
  const { scope } = useOrgProject();
  const { orgId, projectId } = scope;
  const [from, setFrom] = useState(params.get("from") ?? "");
  const [to, setTo] = useState(params.get("to") ?? "");
  const [allTime, setAllTime] = useState(params.get("all_time") === "1");
  const [kindPrefix, setKindPrefix] = useState(params.get("kind") ?? "");

  const [results, setResults] = useState<BrainSearchResult[]>([]);
  const [filesQueried, setFilesQueried] = useState<string[] | undefined>();
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function tsFromInput(s: string): number | undefined {
    if (!s) return undefined;
    const ms = Date.parse(s);
    if (Number.isNaN(ms)) return undefined;
    return Math.floor(ms / 1000);
  }

  async function load() {
    if (!projectId) {
      setResults([]);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const tsFrom = tsFromInput(from);
      const tsTo = tsFromInput(to);
      const fallback = defaultTemporal();
      const spec: BrainQuerySpec = {
        org_id: orgId,
        project_id: projectId,
        // Scope to the selected project; only span the org when the picker
        // is on "— org-level —" (otherwise one project's timeline shows
        // every other project's artifacts).
        scope: projectId && projectId !== ORG_LEVEL ? "project" : "org",
        limit: 200,
        time_range: allTime ? "all_time" : "recent",
        temporal: {
          from: tsFrom ?? fallback.from,
          to: tsTo,
        },
      };
      if (kindPrefix) {
        spec.facets = {
          kind_prefix: kindPrefix
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        };
      }
      const r = await brainSearch(spec);
      setResults(r.results);
      setFilesQueried(r.files_queried);
    } catch (e) {
      setErr(humanizeApiError(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, projectId, from, to, allTime, kindPrefix]);

  function applyFilter(e: React.FormEvent) {
    e.preventDefault();
    // Preserve org/project from the picker; only patch our own params.
    const next = new URLSearchParams(params);
    next.delete("from");
    next.delete("to");
    next.delete("all_time");
    next.delete("kind");
    if (from) next.set("from", from);
    if (to) next.set("to", to);
    if (allTime) next.set("all_time", "1");
    if (kindPrefix) next.set("kind", kindPrefix);
    setParams(next);
  }

  const grouped = useMemo(() => {
    const sorted = [...results].sort((a, b) => b.ts - a.ts);
    const byDay = new Map<string, BrainSearchResult[]>();
    for (const r of sorted) {
      const k = dayKey(r.ts);
      const arr = byDay.get(k) ?? [];
      arr.push(r);
      byDay.set(k, arr);
    }
    return [...byDay.entries()];
  }, [results]);

  const kindCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of results) {
      const top = r.kind.split("/")[0] ?? "artifact";
      m.set(top, (m.get(top) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [results]);

  return (
    <div className="p-6 space-y-4 text-slate-200">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Timeline</h1>
        <span className="text-xs text-slate-500">
          {results.length} artifacts
          {filesQueried && filesQueried.length > 1
            ? ` · fan-out across ${filesQueried.length} files`
            : ""}
        </span>
      </div>

      <form
        onSubmit={applyFilter}
        className="flex flex-wrap gap-3 items-end bg-slate-800/50 p-4 rounded-lg"
      >
        <Field label="From">
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="To">
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Kind prefix">
          <input
            value={kindPrefix}
            onChange={(e) => setKindPrefix(e.target.value)}
            className={inputCls}
            placeholder="conversation/, code/"
          />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={allTime}
            onChange={(e) => setAllTime(e.target.checked)}
          />
          fan out to sealed quarters
        </label>
        <button
          type="submit"
          className="ml-auto px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm"
        >
          Apply
        </button>
      </form>

      {err && (
        <div role="alert" className="text-red-400 bg-red-950/30 border border-red-900 p-3 rounded text-sm">
          {err}
        </div>
      )}

      {kindCounts.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          {kindCounts.map(([kind, n]) => (
            <span
              key={kind}
              className="flex items-center gap-1 px-2 py-1 bg-slate-800 rounded"
            >
              <span
                className="w-2 h-2 rounded-full"
                style={{ background: colourForKind(kind) }}
              />
              {kind}
              <span className="text-slate-500">{n}</span>
            </span>
          ))}
        </div>
      )}

      {loading ? (
        <div className="text-slate-500 text-sm">loading…</div>
      ) : grouped.length === 0 ? (
        <div className="text-slate-500 text-sm py-12 text-center">
          {projectId
            ? "no artifacts in range"
            : "specify a project to view its timeline"}
        </div>
      ) : (
        <ul className="space-y-6">
          {grouped.map(([day, items]) => (
            <li key={day}>
              <div className="flex items-center gap-3 mb-2">
                <h2 className="text-sm font-mono text-slate-400">{day}</h2>
                <span className="text-xs text-slate-600">
                  {items.length} item{items.length === 1 ? "" : "s"}
                </span>
                <div className="flex-1 h-px bg-slate-800" />
              </div>

              {/* Day swimlane: one bar per artifact, x = time of day. */}
              <div className="relative h-6 mb-2 bg-slate-900/40 rounded">
                {items.map((r) => {
                  const d = new Date(r.ts * 1000);
                  const minuteOfDay = d.getHours() * 60 + d.getMinutes();
                  const left = (minuteOfDay / 1440) * 100;
                  return (
                    <Link
                      key={r.hash}
                      to={`/brain/artifact/${r.hash}?org_id=${orgId}`}
                      title={`${r.kind} · ${fmtTime(r.ts)} · ${r.snippet.slice(0, 60)}`}
                      style={{
                        left: `${left}%`,
                        background: colourForKind(r.kind),
                      }}
                      className="absolute top-1 w-1 h-4 rounded-sm hover:w-1.5 hover:opacity-100 opacity-80 transition-all"
                    />
                  );
                })}
              </div>

              {/* List below the swimlane — one row per artifact. */}
              <ul className="space-y-1">
                {items.map((r) => (
                  <li
                    key={r.hash}
                    className="flex items-baseline gap-2 text-sm hover:bg-slate-800/30 rounded px-2 py-1"
                  >
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ background: colourForKind(r.kind) }}
                    />
                    <span className="font-mono text-xs text-slate-500 w-12 flex-shrink-0">
                      {fmtTime(r.ts)}
                    </span>
                    <span className="font-mono text-xs text-slate-400 w-40 flex-shrink-0 truncate">
                      {r.kind}
                    </span>
                    <Link
                      to={`/brain/artifact/${r.hash}?org_id=${orgId}`}
                      className="text-slate-300 hover:text-blue-400 truncate"
                    >
                      <SmartSnippet text={r.snippet} />
                    </Link>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const inputCls =
  "bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wide text-slate-400 mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}
