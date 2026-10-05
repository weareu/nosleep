/**
 * Brain Entity hub — `/brain/entity/:id`. Shows the canonical name,
 * aliases, recent mentions across thoughts + artifacts, related entities
 * by co-occurrence, and the merge-target if this entity has been merged.
 */

import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { humanizeApiError } from "../../lib/humanize-error";
import {
  brainGetEntity,
  type BrainEntityDetail,
} from "../../lib/brainApi";

const KIND_COLOURS: Record<string, string> = {
  topic: "#0ea5e9",
  person: "#f472b6",
  concept: "#84cc16",
  external_project: "#fb923c",
  tool: "#94a3b8",
  agent: "#a3e635",
  place: "#fbbf24",
};

function colourFor(kind: string): string {
  return KIND_COLOURS[kind] ?? "#64748b";
}

export function BrainEntity(): React.ReactElement {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const orgId = params.get("org") ?? params.get("org_id") ?? "org_personal";

  const [entity, setEntity] = useState<BrainEntityDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setErr(null);
    brainGetEntity(id, orgId)
      .then(setEntity)
      .catch((e) => setErr(humanizeApiError(e)))
      .finally(() => setLoading(false));
  }, [id, orgId]);

  return (
    <div className="p-6 space-y-5 text-slate-200">
      <div>
        <h1 className="text-2xl font-bold">Entity</h1>
        <div className="font-mono text-xs text-slate-500 break-all mt-1">
          {id}
        </div>
      </div>

      {err && (
        <div role="alert" className="text-red-400 bg-red-950/30 border border-red-900 p-3 rounded">
          {err}
        </div>
      )}

      {loading && <div className="text-slate-500 text-sm">loading…</div>}

      {entity && (
        <>
          <section className="bg-slate-800/40 border border-slate-800 rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-3">
              <span
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ background: colourFor(entity.kind) }}
              />
              <h2 className="text-xl font-semibold">{entity.canonical_name}</h2>
              <span className="text-xs text-slate-500 uppercase tracking-wide">
                {entity.kind}
              </span>
              {entity.visibility !== "active" && (
                <span className="text-xs px-2 py-0.5 rounded bg-amber-900/40 text-amber-300">
                  {entity.visibility}
                </span>
              )}
            </div>

            {entity.merged_into && entity.merge_target && (
              <div className="text-xs text-amber-300 bg-amber-950/30 border border-amber-900 rounded p-2">
                Merged into{" "}
                <Link
                  to={`/brain/entity/${entity.merge_target.id}?org=${orgId}`}
                  className="text-amber-200 underline font-medium"
                >
                  {entity.merge_target.canonical_name}
                </Link>{" "}
                — queries for this entity transparently resolve to the target.
              </div>
            )}

            {entity.aliases.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {entity.aliases.map((a) => (
                  <span
                    key={a}
                    className="text-xs px-2 py-0.5 bg-slate-900 border border-slate-700 rounded text-slate-300"
                  >
                    {a}
                  </span>
                ))}
              </div>
            )}

            <div className="text-xs text-slate-500">
              {entity.ref_count} reference{entity.ref_count === 1 ? "" : "s"} ·
              created {new Date(entity.created_at * 1000).toLocaleString()}
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-2">
              Recent mentions ({entity.recent_refs.length})
            </h3>
            {entity.recent_refs.length === 0 ? (
              <div className="text-slate-500 text-sm">no mentions yet</div>
            ) : (
              <ul className="space-y-1">
                {entity.recent_refs.map((r, i) => (
                  <li
                    key={`${r.referrer_id}-${i}`}
                    className="flex items-center gap-3 text-sm py-2 border-b border-slate-800/40"
                  >
                    <span className="font-mono text-[10px] text-slate-600 uppercase w-16">
                      {r.referrer_kind}
                    </span>
                    <span className="text-xs text-slate-500 w-32">
                      {new Date(r.created_at * 1000).toLocaleString()}
                    </span>
                    <Link
                      to={
                        r.referrer_kind === "thought"
                          ? `/brain/thought/${r.referrer_id}?org_id=${orgId}`
                          : `/brain/artifact/${r.referrer_id}?org_id=${orgId}`
                      }
                      className="text-blue-400 hover:underline truncate font-mono text-xs"
                    >
                      {r.referrer_id.slice(0, 16)}…
                    </Link>
                    <span className="text-xs text-slate-500 ml-auto">
                      {r.relation}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-2">
              Related entities ({entity.related.length})
            </h3>
            {entity.related.length === 0 ? (
              <div className="text-slate-500 text-sm">
                no co-occurring entities yet — they'll appear once two
                entities share a thought.
              </div>
            ) : (
              <ul className="space-y-1">
                {entity.related.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center gap-2 py-1.5 border-b border-slate-800/40"
                  >
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ background: colourFor(r.kind) }}
                    />
                    <Link
                      to={`/brain/entity/${r.id}?org=${orgId}`}
                      className="text-blue-400 hover:underline text-sm flex-1 truncate"
                    >
                      {r.canonical_name}
                    </Link>
                    <span className="text-xs text-slate-500 uppercase">{r.kind}</span>
                    <span className="text-xs text-slate-400 w-12 text-right">
                      ×{r.co_count}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
