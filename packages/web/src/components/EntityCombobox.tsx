/**
 * Phase 12 (UI review H3) — type-ahead entity picker for the merge queue.
 *
 * Replaces the raw `<input>` for entity IDs with a debounced, click-to-pick
 * combobox driven by /api/brain/entities. Caller passes `value` (the
 * entity_id) + `onChange`.
 */

import { useEffect, useRef, useState } from "react";
import {
  brainListEntities,
  type BrainEntityListItem,
} from "../lib/brainApi";

const KIND_COLOURS: Record<string, string> = {
  topic: "#0ea5e9",
  person: "#f472b6",
  concept: "#84cc16",
  external_project: "#fb923c",
  tool: "#94a3b8",
  agent: "#a3e635",
  place: "#fbbf24",
};

export function EntityCombobox({
  value,
  onChange,
  orgId,
  placeholder,
  /** Filter out this entity from the list (avoid self-merge). */
  excludeId,
}: {
  value: string;
  onChange: (id: string, name?: string) => void;
  orgId: string;
  placeholder?: string;
  excludeId?: string;
}): React.ReactElement {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<BrainEntityListItem[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedName, setSelectedName] = useState<string>("");
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Initial load: list top entities by ref_count.
  useEffect(() => {
    setLoading(true);
    brainListEntities({ org_id: orgId, order: "ref_count", limit: 50 })
      .then((r) => setItems(r.items))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [orgId]);

  // Click-outside to close.
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // Resolve display name when value comes in pre-set (e.g. from URL param).
  useEffect(() => {
    if (!value) {
      setSelectedName("");
      return;
    }
    const hit = items.find((i) => i.id === value);
    if (hit) setSelectedName(hit.canonical_name);
  }, [value, items]);

  const filtered = (
    query.trim()
      ? items.filter((i) =>
          i.canonical_name.toLowerCase().includes(query.toLowerCase()),
        )
      : items
  ).filter((i) => i.id !== excludeId);

  return (
    <div ref={wrapperRef} className="relative">
      <input
        value={open ? query : (selectedName || query)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder ?? "search entity by name…"}
        className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      {value && !open && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-mono text-slate-500 pointer-events-none">
          {value.slice(0, 8)}
        </div>
      )}
      {open && (
        <div className="absolute left-0 right-0 mt-1 bg-slate-900 border border-slate-700 rounded shadow-lg max-h-64 overflow-y-auto z-10">
          {loading ? (
            <div className="px-3 py-2 text-xs text-slate-500">loading…</div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-500">
              no matches{query ? ` for "${query}"` : ""}
            </div>
          ) : (
            filtered.slice(0, 50).map((it) => (
              <button
                key={it.id}
                type="button"
                onClick={() => {
                  onChange(it.id, it.canonical_name);
                  setSelectedName(it.canonical_name);
                  setQuery("");
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-2 hover:bg-slate-800 flex items-center gap-2 ${
                  value === it.id ? "bg-slate-800" : ""
                }`}
              >
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ background: KIND_COLOURS[it.kind] ?? "#64748b" }}
                />
                <span className="text-sm text-slate-200 flex-1 truncate">
                  {it.canonical_name}
                </span>
                <span className="text-[10px] uppercase text-slate-500">
                  {it.kind}
                </span>
                <span className="text-xs text-slate-400 w-10 text-right">
                  ×{it.ref_count}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
