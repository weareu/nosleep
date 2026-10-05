import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { humanizeApiError } from "../../lib/humanize-error";
import {
  brainListCodeSymbols,
  brainListCodeFiles,
  type BrainCodeSymbol,
  type BrainCodeFile,
} from "../../lib/brainApi";
import { useOrgProject } from "../../components/OrgProjectPicker";

const KINDS = ["", "function", "class", "interface", "type", "enum", "import", "variable"];

export function BrainCode(): React.ReactElement {
  const { scope } = useOrgProject();
  const { orgId, projectId } = scope;
  const [tab, setTab] = useState<"symbols" | "files">("symbols");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [language, setLanguage] = useState("");

  const [symbols, setSymbols] = useState<BrainCodeSymbol[]>([]);
  const [files, setFiles] = useState<BrainCodeFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    if (!projectId) return;
    setLoading(true);
    setErr(null);
    try {
      if (tab === "symbols") {
        const r = await brainListCodeSymbols({
          org_id: orgId,
          project_id: projectId,
          q: query || undefined,
          symbol_kind: kind || undefined,
          language: language || undefined,
          limit: 100,
        });
        setSymbols(r.items);
      } else {
        const r = await brainListCodeFiles({
          org_id: orgId,
          project_id: projectId,
          q: query || undefined,
          limit: 100,
        });
        setFiles(r.items);
      }
    } catch (e) {
      setErr(humanizeApiError(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, projectId, tab, query, kind, language]);

  return (
    <div className="p-6 space-y-4 text-slate-200">
      <h1 className="text-2xl font-bold">Code</h1>

      <section className="flex flex-wrap gap-3 items-end bg-slate-800/50 p-4 rounded-lg">
        <Field label="Search">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={inputCls}
            placeholder="symbol or file"
          />
        </Field>
        {tab === "symbols" && (
          <>
            <Field label="Kind">
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value)}
                className={inputCls}
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k || "(any)"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Language">
              <input
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className={`${inputCls} w-32`}
                placeholder="typescript"
              />
            </Field>
          </>
        )}
      </section>

      <div className="flex gap-2 border-b border-slate-800">
        {(["symbols", "files"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm border-b-2 ${
              tab === t
                ? "text-white border-blue-500"
                : "text-slate-400 border-transparent hover:text-slate-200"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {err && (
        <div role="alert" className="text-red-400 bg-red-950/30 border border-red-900 p-3 rounded">
          {err}
        </div>
      )}

      {loading ? (
        <div className="text-slate-400">loading…</div>
      ) : tab === "symbols" ? (
        <ul className="divide-y divide-slate-800">
          {symbols.map((s, i) => (
            <li
              key={`${s.hash}-${s.symbol}-${i}`}
              className="py-2 flex items-baseline gap-3"
            >
              <span className="font-mono text-xs uppercase tracking-wide text-slate-500 w-20 shrink-0">
                {s.symbol_kind}
              </span>
              <Link
                to={`/brain/artifact/${s.hash}?org_id=${orgId}`}
                className="font-mono text-sm text-blue-300 hover:underline truncate"
              >
                {s.symbol}
              </Link>
              <span className="text-xs text-slate-500 truncate">
                {s.file_path ?? "—"}
                {s.line_start ? `:${s.line_start}` : ""} · {s.language}
              </span>
            </li>
          ))}
          {!symbols.length && (
            <li className="text-slate-500 text-sm py-3">no symbols</li>
          )}
        </ul>
      ) : (
        <ul className="divide-y divide-slate-800">
          {files.map((f) => (
            <li key={f.file_path} className="py-2 flex items-baseline gap-3">
              <span className="font-mono text-sm text-slate-200 truncate flex-1">
                {f.file_path}
              </span>
              <span className="text-xs text-slate-500 shrink-0">
                {f.snapshots} snapshot{f.snapshots === 1 ? "" : "s"} ·{" "}
                {f.symbol_count} symbols · {f.language}
              </span>
              <span className="text-xs text-slate-600 shrink-0">
                {new Date(f.last_seen * 1000).toLocaleDateString()}
              </span>
            </li>
          ))}
          {!files.length && (
            <li className="text-slate-500 text-sm py-3">no files</li>
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
