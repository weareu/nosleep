import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { humanizeApiError } from "../../../lib/humanize-error";
import {
  brainAdminQueryLogs,
  brainAdminQueryLog,
  type QueryLogSummary,
} from "../../../lib/brainApi";
import { useOrgProject } from "../../../components/OrgProjectPicker";
import { SkeletonStack } from "../../../components/Skeleton";

export function BrainAdminQueryLogs(): React.ReactElement {
  const { scope } = useOrgProject();
  const orgId = scope.orgId;
  const [items, setItems] = useState<QueryLogSummary[]>([]);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await brainAdminQueryLogs({ org_id: orgId, limit: 100 });
      setItems(r.items);
    } catch (e) {
      setErr(humanizeApiError(e));
    } finally {
      setLoading(false);
    }
  }

  async function inspect(id: string) {
    setSelected(null);
    try {
      const r = await brainAdminQueryLog(id, orgId);
      setSelected(r);
    } catch (e) {
      setErr(humanizeApiError(e));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  return (
    <div className="p-6 grid md:grid-cols-2 gap-4 text-slate-200">
      <div>
        <Link to={`/admin/brain?org_id=${orgId}`} className="text-blue-400 text-xs hover:underline">
          ← admin
        </Link>
        <h1 className="text-2xl font-bold mb-3">Query Logs</h1>

        {err && (
          <div role="alert" className="text-red-400 bg-red-950/30 border border-red-900 p-3 rounded text-sm mb-3">
            {err}
          </div>
        )}
        {loading ? (
          <SkeletonStack rows={6} />
        ) : (
          <ul className="divide-y divide-slate-800">
            {items.map((q) => (
              <li
                key={q.query_id}
                className="py-2 cursor-pointer hover:bg-slate-800/30 px-2"
                onClick={() => inspect(q.query_id)}
              >
                <div className="flex justify-between items-baseline">
                  <span className="font-mono text-xs text-slate-400">
                    {q.intent ?? "—"}
                  </span>
                  <span className="text-xs text-slate-500">
                    {q.latency_ms?.toFixed(1) ?? "?"}ms
                  </span>
                </div>
                <div className="text-xs text-slate-300 truncate mt-1">
                  {summary(q.query_spec_json)}
                </div>
                <div className="text-xs text-slate-600 mt-0.5">
                  {new Date(q.ts * 1000).toLocaleString()}
                  {q.confidence_score !== null &&
                    ` · conf ${q.confidence_score.toFixed(2)}`}
                </div>
              </li>
            ))}
            {!items.length && (
              <li className="text-slate-500 text-sm py-3">no queries logged yet</li>
            )}
          </ul>
        )}
      </div>

      <aside className="bg-slate-800/40 border border-slate-800 rounded-lg p-4 sticky top-4 self-start max-h-[80vh] overflow-y-auto">
        <h2 className="text-sm font-semibold mb-3">Detail</h2>
        {selected ? <QueryDetail row={selected} orgId={orgId} /> : (
          <div className="text-slate-500 text-sm">click a query for full pipeline view</div>
        )}
      </aside>
    </div>
  );
}

interface QueryDetailRow {
  query_id?: string;
  ts?: number;
  intent?: string | null;
  latency_ms?: number | null;
  confidence_score?: number | null;
  query_spec_json?: string;
  retrievers_json?: string | null;
  fused_top_json?: string | null;
  reranked_top_json?: string | null;
  chosen_ids_json?: string | null;
  used_ids_json?: string | null;
}

function QueryDetail({
  row,
  orgId,
}: {
  row: Record<string, unknown>;
  orgId: string;
}): React.ReactElement {
  const r = row as QueryDetailRow;
  const spec = safeParseJson<Record<string, unknown>>(r.query_spec_json);
  const retrievers = safeParseJson<RetrieverSummary[]>(r.retrievers_json);
  const fused = safeParseJson<FusedHit[]>(r.fused_top_json);
  const usedIds = new Set(safeParseJson<string[]>(r.used_ids_json) ?? []);
  const chosenIds = safeParseJson<string[]>(r.chosen_ids_json) ?? [];

  return (
    <div className="space-y-4 text-sm">
      <Section label="Summary">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-slate-500">id</dt>
          <dd className="font-mono break-all">{r.query_id ?? "—"}</dd>
          <dt className="text-slate-500">when</dt>
          <dd>{r.ts ? new Date(r.ts * 1000).toLocaleString() : "—"}</dd>
          <dt className="text-slate-500">intent</dt>
          <dd>{r.intent ?? "—"}</dd>
          <dt className="text-slate-500">latency</dt>
          <dd>{r.latency_ms != null ? `${r.latency_ms.toFixed(1)} ms` : "—"}</dd>
          <dt className="text-slate-500">confidence</dt>
          <dd>
            {r.confidence_score != null
              ? r.confidence_score.toFixed(3)
              : "—"}
          </dd>
        </dl>
      </Section>

      <Section label="Spec">
        {spec ? (
          <ul className="text-xs space-y-1">
            {Boolean(spec.text) && typeof spec.text === "object" ? (
              <li className="text-slate-300">
                <span className="text-slate-500">text:</span>{" "}
                <code className="bg-slate-900 px-1 rounded">
                  {JSON.stringify(spec.text)}
                </code>
              </li>
            ) : null}
            {Boolean(spec.facets) ? (
              <li className="text-slate-300">
                <span className="text-slate-500">facets:</span>{" "}
                <code className="bg-slate-900 px-1 rounded">
                  {JSON.stringify(spec.facets)}
                </code>
              </li>
            ) : null}
            {Boolean(spec.temporal) ? (
              <li className="text-slate-300">
                <span className="text-slate-500">temporal:</span>{" "}
                <code className="bg-slate-900 px-1 rounded">
                  {JSON.stringify(spec.temporal)}
                </code>
              </li>
            ) : null}
            {Boolean(spec.scope) ? (
              <li className="text-slate-300">
                <span className="text-slate-500">scope:</span>{" "}
                <code className="bg-slate-900 px-1 rounded">{String(spec.scope)}</code>
              </li>
            ) : null}
            {Boolean(spec.time_range) ? (
              <li className="text-slate-300">
                <span className="text-slate-500">time_range:</span>{" "}
                <code className="bg-slate-900 px-1 rounded">{String(spec.time_range)}</code>
              </li>
            ) : null}
          </ul>
        ) : (
          <div className="text-slate-600 text-xs">spec not parseable</div>
        )}
      </Section>

      <Section
        label={`Pipeline · ${retrievers?.length ?? 0} stage${(retrievers?.length ?? 0) === 1 ? "" : "s"}`}
      >
        {retrievers && retrievers.length > 0 ? (
          <ul className="text-xs space-y-1.5">
            {retrievers.map((stage, i) => (
              <li
                key={`${stage.retriever}-${i}`}
                className="flex items-baseline gap-2 border-l-2 border-slate-700 pl-2"
              >
                <span className="font-mono text-slate-200">{stage.retriever}</span>
                <span className="text-slate-500">
                  weight {stage.weight ?? 1}
                </span>
                <span className="text-slate-500">
                  · {stage.top20?.length ?? 0} hits
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-slate-600 text-xs">no retrievers fired</div>
        )}
      </Section>

      <Section label={`Results · ${fused?.length ?? 0}`}>
        {fused && fused.length > 0 ? (
          <ul className="text-xs space-y-0.5 max-h-64 overflow-y-auto">
            {fused.map((hit, i) => {
              const isUsed = usedIds.has(hit.hash);
              const isChosen = chosenIds.includes(hit.hash);
              return (
                <li
                  key={hit.hash + i}
                  className="flex items-baseline gap-2 py-0.5"
                >
                  <span className="text-slate-600 w-6 text-right">
                    {i + 1}.
                  </span>
                  <Link
                    to={`/brain/artifact/${hit.hash}?org_id=${orgId}`}
                    className="font-mono text-blue-400 hover:underline"
                  >
                    {hit.hash.slice(0, 12)}…
                  </Link>
                  {typeof hit.score === "number" && (
                    <span className="text-slate-500">
                      {hit.score.toFixed(4)}
                    </span>
                  )}
                  {isUsed && (
                    <span className="text-emerald-400 text-[10px] uppercase">
                      used
                    </span>
                  )}
                  {isChosen && !isUsed && (
                    <span className="text-amber-400 text-[10px] uppercase">
                      chosen
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="text-slate-600 text-xs">no fused result</div>
        )}
      </Section>
    </div>
  );
}

interface RetrieverSummary {
  retriever: string;
  weight?: number;
  top20?: Array<{ hash: string; rank: number; raw: number }>;
}
interface FusedHit {
  hash: string;
  score?: number;
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section>
      <h3 className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">
        {label}
      </h3>
      {children}
    </section>
  );
}

function safeParseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function summary(json: string): string {
  try {
    const parsed = JSON.parse(json) as { text?: { query?: string }; image?: unknown };
    if (parsed.text?.query) return `text: ${parsed.text.query}`;
    if (parsed.image) return "image query";
    return json.slice(0, 100);
  } catch {
    return json.slice(0, 100);
  }
}
