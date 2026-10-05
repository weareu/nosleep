import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { humanizeApiError } from "../../lib/humanize-error";
import {
  brainListThoughts,
  brainCaptureThought,
  brainThoughtStats,
  type BrainThought,
} from "../../lib/brainApi";
import { useOrgProject } from "../../components/OrgProjectPicker";
import { Markdown } from "../../components/Markdown";

const TYPES = [
  "observation",
  "task",
  "idea",
  "reference",
  "person_note",
  "decision",
  "insight",
  "question",
];

export function BrainThoughts(): React.ReactElement {
  const { scope } = useOrgProject();
  const { orgId, projectId } = scope;
  const [typeFilter, setTypeFilter] = useState("");
  const [topicFilter, setTopicFilter] = useState("");
  const [days, setDays] = useState<number | "">("");

  const [items, setItems] = useState<BrainThought[]>([]);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof brainThoughtStats>> | null>(null);
  const [captureText, setCaptureText] = useState("");
  const [captureHint, setCaptureHint] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    if (!projectId) return;
    setLoading(true);
    setErr(null);
    try {
      const [listed, s] = await Promise.all([
        brainListThoughts({
          org_id: orgId,
          project_id: projectId,
          type: typeFilter || undefined,
          topic: topicFilter || undefined,
          days: days === "" ? undefined : Number(days),
          limit: 50,
        }),
        brainThoughtStats({ org_id: orgId, project_id: projectId }),
      ]);
      setItems(listed.items);
      setStats(s);
    } catch (e) {
      setErr(humanizeApiError(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, projectId, typeFilter, topicFilter, days]);

  async function doCapture(e: React.FormEvent) {
    e.preventDefault();
    if (!captureText.trim() || !projectId) return;
    try {
      await brainCaptureThought({
        content: captureText,
        org_id: orgId,
        project_id: projectId,
        source_kind: "web_ui",
        thought_type_hint: captureHint || undefined,
      });
      setCaptureText("");
      setCaptureHint("");
      await load();
    } catch (e) {
      setErr(humanizeApiError(e));
    }
  }

  return (
    <div className="p-6 space-y-6 text-slate-200">
      <h1 className="text-2xl font-bold">Thoughts</h1>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <form
          onSubmit={doCapture}
          className="col-span-2 bg-slate-800/50 p-4 rounded-lg space-y-3"
        >
          <h2 className="text-sm font-semibold text-slate-300">Capture a thought</h2>
          <textarea
            value={captureText}
            onChange={(e) => setCaptureText(e.target.value)}
            rows={3}
            className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="What's worth remembering?"
          />
          <div className="flex gap-3 items-end">
            <div className="flex-1">
              <label className="block text-xs uppercase tracking-wide text-slate-400 mb-1">
                type hint
              </label>
              <select
                value={captureHint}
                onChange={(e) => setCaptureHint(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">(auto-detect)</option>
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              disabled={!captureText.trim() || !projectId}
              className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium"
            >
              Capture
            </button>
          </div>
        </form>

        <div className="bg-slate-800/50 p-4 rounded-lg space-y-2">
          <h2 className="text-sm font-semibold text-slate-300">Stats</h2>
          {stats ? (
            <dl className="text-xs text-slate-300 space-y-1">
              <div>total: {stats.total}</div>
              {stats.types.slice(0, 5).map((t) => (
                <div key={t.type} className="text-slate-400">
                  {t.type}: {t.count}
                </div>
              ))}
              {stats.top_topics.length > 0 && (
                <div className="pt-1 mt-1 border-t border-slate-700">
                  top topics:
                  <div className="flex flex-wrap gap-1 mt-1">
                    {stats.top_topics.slice(0, 8).map((t) => (
                      <span
                        key={t.topic}
                        className="bg-slate-900 px-2 py-0.5 rounded text-slate-300"
                      >
                        {t.topic} ({t.count})
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </dl>
          ) : (
            <div className="text-slate-500 text-xs">specify a project to view stats</div>
          )}
        </div>
      </section>

      <section className="flex flex-wrap gap-3 items-end bg-slate-800/50 p-4 rounded-lg">
        <Field label="Type">
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className={inputCls}
          >
            <option value="">(all)</option>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Topic">
          <input
            value={topicFilter}
            onChange={(e) => setTopicFilter(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Days">
          <input
            type="number"
            min="1"
            value={days}
            onChange={(e) => setDays(e.target.value === "" ? "" : Number(e.target.value))}
            className={`${inputCls} w-24`}
          />
        </Field>
      </section>

      {err && (
        <div role="alert" className="text-red-400 bg-red-950/30 border border-red-900 p-3 rounded">{err}</div>
      )}

      {loading ? (
        <div className="text-slate-400">loading…</div>
      ) : (
        <ul className="space-y-3">
          {items.map((t) => (
            <li
              key={t.id}
              className="bg-slate-800/50 border border-slate-700 p-4 rounded-lg"
            >
              <div className="flex items-start justify-between gap-3 mb-1">
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <span className="font-mono bg-slate-900 px-1.5 py-0.5 rounded">
                    {t.thought_type ?? "?"}
                  </span>
                  <span>{new Date(t.created_at * 1000).toLocaleString()}</span>
                  {t.source_kind && <span>· {t.source_kind}</span>}
                </div>
                <Link
                  to={`/brain/thought/${t.id}?org_id=${orgId}`}
                  className="text-xs text-blue-400 hover:underline"
                >
                  open →
                </Link>
              </div>
              <div className="text-slate-200 break-words">
                <Markdown>{t.content}</Markdown>
              </div>
              {(t.metadata.topics.length > 0 || t.metadata.people.length > 0) && (
                <div className="mt-2 flex flex-wrap gap-1 text-xs">
                  {t.metadata.topics.map((tp) => (
                    <span
                      key={`tp-${tp}`}
                      className="bg-blue-950/50 text-blue-300 px-2 py-0.5 rounded"
                    >
                      {tp}
                    </span>
                  ))}
                  {t.metadata.people.map((p) => (
                    <span
                      key={`p-${p}`}
                      className="bg-purple-950/50 text-purple-300 px-2 py-0.5 rounded"
                    >
                      @{p}
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
          {!items.length && !loading && (
            <li className="text-slate-500 text-sm">
              no thoughts yet — capture one above or specify a project
            </li>
          )}
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
