import { useEffect, useState } from "react";
import { humanizeApiError } from "../../../lib/humanize-error";
import {
  brainAdminConfigList,
  brainAdminConfigSet,
  type BrainConfigItem,
} from "../../../lib/brainApi";
import { useOrgProject } from "../../../components/OrgProjectPicker";

export function BrainAdminConfig(): React.ReactElement {
  const { scope } = useOrgProject();
  const orgId = scope.orgId;
  const [items, setItems] = useState<BrainConfigItem[]>([]);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await brainAdminConfigList(orgId);
      setItems(r.items);
    } catch (e) {
      setErr(humanizeApiError(e));
    } finally {
      setLoading(false);
    }
  }

  async function save(key: string, valueText: string) {
    setSaving(true);
    setErr(null);
    try {
      let value: unknown = valueText;
      try {
        value = JSON.parse(valueText);
      } catch {
        // keep as string
      }
      await brainAdminConfigSet({ org_id: orgId, key, value });
      await load();
      setNewKey("");
      setNewValue("");
    } catch (e) {
      setErr(humanizeApiError(e));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  return (
    <div className="p-6 space-y-4 text-slate-200">
      <h1 className="text-2xl font-bold">Brain Config</h1>
      <p className="text-sm text-slate-400">
        Per-org tunables. Common keys: <code className="text-xs bg-slate-800 px-1 rounded">org.embed_allowlist</code>,{" "}
        <code className="text-xs bg-slate-800 px-1 rounded">project.&lt;id&gt;.embed_allowlist</code>,{" "}
        <code className="text-xs bg-slate-800 px-1 rounded">org.intent_weights</code>.
      </p>

      {err && (
        <div role="alert" className="text-red-400 bg-red-950/30 border border-red-900 p-3 rounded text-sm">
          {err}
        </div>
      )}

      <section className="bg-slate-800/40 border border-slate-800 rounded p-4 space-y-2">
        <h2 className="text-sm font-semibold">Set / update</h2>
        <div className="flex gap-2">
          <input
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="org.embed_allowlist"
            className="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm font-mono"
          />
          <input
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            placeholder='["conversation/turn/", "code/diff", ...]'
            className="flex-[2] bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm font-mono"
          />
          <button
            type="button"
            onClick={() => save(newKey, newValue)}
            disabled={!newKey || saving}
            className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm"
          >
            {saving ? "Saving…" : "Set"}
          </button>
        </div>
      </section>

      {loading ? (
        <div className="text-slate-500 text-sm">loading…</div>
      ) : (
        <ul className="divide-y divide-slate-800">
          {items.map((c) => (
            <li key={c.key} className="py-3">
              <div className="flex justify-between mb-1">
                <span className="font-mono text-xs text-slate-400">{c.key}</span>
                <span className="text-xs text-slate-600">
                  {new Date(c.updated_at * 1000).toLocaleString()}
                </span>
              </div>
              <pre className="text-xs bg-slate-900/50 p-2 rounded overflow-x-auto whitespace-pre-wrap break-words">
                {JSON.stringify(c.value, null, 2)}
              </pre>
            </li>
          ))}
          {!items.length && (
            <li className="text-slate-500 text-sm py-3">no config set</li>
          )}
        </ul>
      )}
    </div>
  );
}
