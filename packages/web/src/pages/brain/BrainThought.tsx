import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { humanizeApiError } from "../../lib/humanize-error";
import { brainGetThought, type BrainThought as BrainThoughtT } from "../../lib/brainApi";
import {
  BrainDetailHero,
  BrainDetailToolbar,
  CodeIcon,
  CopyIcon,
  GraphIcon,
} from "../../components/BrainDetailHero";
import { JsonViewerModal } from "../../components/JsonViewerModal";
import { Markdown } from "../../components/Markdown";

export function BrainThought(): React.ReactElement {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const orgId =
    params.get("org") ?? params.get("org_id") ?? "org_personal";

  const [t, setT] = useState<BrainThoughtT | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    brainGetThought(id, orgId, ["refs"])
      .then(setT)
      .catch((e) => setErr(humanizeApiError(e)))
      .finally(() => setLoading(false));
  }, [id, orgId]);

  const heroTitle = t ? deriveThoughtTitle(t) : "Thought";
  const heroSubtitle = t ? (
    <>
      <span className="font-mono">{t.thought_type ?? "?"}</span>
      <span>·</span>
      <span>{new Date(t.created_at * 1000).toLocaleString()}</span>
      {t.source_kind && (
        <>
          <span>·</span>
          <span>{t.source_kind}</span>
        </>
      )}
      {t.visibility !== "active" && (
        <>
          <span>·</span>
          <span className="text-amber-400">{t.visibility}</span>
        </>
      )}
    </>
  ) : null;

  return (
    <div className="p-6 space-y-4 text-slate-200">
      <BrainDetailToolbar
        actions={[
          {
            label: "Copy id",
            icon: <CopyIcon />,
            onClick: () => navigator.clipboard.writeText(id).catch(() => {}),
          },
          {
            label: "Open graph",
            icon: <GraphIcon />,
            to: `/brain/graph?org_id=${orgId}&thought=${id}`,
          },
          {
            label: "Raw JSON",
            icon: <CodeIcon />,
            onClick: () => setShowJson(true),
            disabled: !t,
          },
        ]}
      />

      <JsonViewerModal
        open={showJson}
        onClose={() => setShowJson(false)}
        title={`Thought ${id.slice(0, 12)}${id.length > 12 ? "…" : ""}`}
        data={t}
      />


      <BrainDetailHero
        eyebrow="Thought"
        title={heroTitle}
        subtitle={heroSubtitle}
        identifier={id}
        backTo={`/brain/thoughts?org=${orgId}`}
        backLabel="Thoughts"
      />

      {err && (
        <div role="alert" className="text-red-400 bg-red-950/30 border border-red-900 p-3 rounded">{err}</div>
      )}

      {loading ? (
        <div className="text-slate-400">loading…</div>
      ) : t ? (
        <div className="space-y-6">
          <section className="bg-slate-800/50 border border-slate-800 p-4 rounded-lg">
            <div className="text-slate-100 break-words">
              <Markdown>{t.content}</Markdown>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-4 text-xs">
              <MetaChips label="topics" items={t.metadata.topics} colour="blue" />
              <MetaChips
                label="people"
                items={t.metadata.people.map((p) => `@${p}`)}
                colour="purple"
              />
              <MetaChips
                label="action items"
                items={t.metadata.action_items}
                colour="amber"
              />
              <MetaChips
                label="dates mentioned"
                items={t.metadata.dates_mentioned}
                colour="slate"
              />
            </div>
          </section>

          {t.archive_refs && t.archive_refs.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold mb-2">Source artifacts</h2>
              <ul className="space-y-1 text-xs">
                {t.archive_refs.map((r) => (
                  <li key={`${r.archive_hash}-${r.relation}`}>
                    <Link
                      to={`/brain/artifact/${r.archive_hash}?org_id=${orgId}`}
                      className="font-mono text-blue-400 hover:underline"
                    >
                      {r.archive_hash.slice(0, 12)}…
                    </Link>
                    <span className="ml-2 text-slate-500">[{r.relation}]</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {t.thought_refs && (t.thought_refs.outgoing.length > 0 || t.thought_refs.incoming.length > 0) && (
            <section>
              <h2 className="text-sm font-semibold mb-2">Linked thoughts</h2>
              <div className="grid md:grid-cols-2 gap-3 text-xs">
                <EdgeList
                  title="outgoing"
                  edges={t.thought_refs.outgoing}
                  targetKey="to_thought_id"
                  orgId={orgId}
                />
                <EdgeList
                  title="incoming"
                  edges={t.thought_refs.incoming}
                  targetKey="from_thought_id"
                  orgId={orgId}
                />
              </div>
            </section>
          )}

          {t.entity_refs && t.entity_refs.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold mb-2">Entities</h2>
              <ul className="space-y-1 text-xs">
                {t.entity_refs.map((e) => (
                  <li key={`${e.entity_id}-${e.relation}`} className="font-mono">
                    {e.entity_id} <span className="text-slate-500">[{e.relation}]</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      ) : null}
    </div>
  );
}

function deriveThoughtTitle(t: BrainThoughtT): string {
  if (t.content) {
    const firstLine = t.content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (firstLine) {
      return firstLine.length > 140 ? `${firstLine.slice(0, 140)}…` : firstLine;
    }
  }
  return t.thought_type ?? "Thought";
}

function MetaChips({
  label,
  items,
  colour,
}: {
  label: string;
  items: string[];
  colour: "blue" | "purple" | "amber" | "slate";
}): React.ReactElement {
  const colourMap: Record<string, string> = {
    blue: "bg-blue-950/50 text-blue-300",
    purple: "bg-purple-950/50 text-purple-300",
    amber: "bg-amber-950/50 text-amber-300",
    slate: "bg-slate-800 text-slate-300",
  };
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">{label}</div>
      {items.length === 0 ? (
        <div className="text-slate-500 text-xs">—</div>
      ) : (
        <div className="flex flex-wrap gap-1">
          {items.map((it) => (
            <span key={it} className={`${colourMap[colour]} px-2 py-0.5 rounded`}>
              {it}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function EdgeList({
  title,
  edges,
  targetKey,
  orgId,
}: {
  title: string;
  edges: Array<{ relation: string; to_thought_id?: string; from_thought_id?: string }>;
  targetKey: "to_thought_id" | "from_thought_id";
  orgId: string;
}): React.ReactElement {
  return (
    <div className="bg-slate-800/40 border border-slate-800 p-3 rounded">
      <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">{title}</div>
      {edges.length === 0 ? (
        <div className="text-slate-500">—</div>
      ) : (
        <ul className="space-y-1">
          {edges.map((e, i) => {
            const target = (e as unknown as Record<string, string>)[targetKey];
            return (
              <li key={`${target}-${e.relation}-${i}`}>
                <Link
                  to={`/brain/thought/${target}?org_id=${orgId}`}
                  className="font-mono text-blue-400 hover:underline"
                >
                  {target}
                </Link>
                <span className="ml-2 text-slate-500">[{e.relation}]</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
