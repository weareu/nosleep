import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { OrgBadge } from "../components/OrgBadge";
import {
  createOrg,
  deleteOrg,
  fetchOrgs,
  updateOrg,
  type OrgWithStats,
} from "../lib/api";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const DEFAULT_ORG_ID = "org_personal";

const inputCls =
  "w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500";

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function NewOrgForm({ onDone }: { onDone: () => void }): React.ReactElement {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [color, setColor] = useState("");
  const effectiveSlug = slug || slugify(name);
  const slugOk = SLUG_RE.test(effectiveSlug);

  const create = useMutation({
    mutationFn: () => createOrg({ name: name.trim(), slug: effectiveSlug, ...(color ? { color } : {}) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orgs"] });
      onDone();
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && slugOk) create.mutate();
      }}
      className="mb-4 bg-slate-900/60 rounded-lg border border-slate-700/50 p-4 grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto_auto] gap-3 items-end"
    >
      <div>
        <label htmlFor="org-name" className="block text-xs text-slate-400 mb-1">Name</label>
        <input id="org-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="e.g. Client X" className={inputCls} />
      </div>
      <div>
        <label htmlFor="org-slug" className="block text-xs text-slate-400 mb-1">Slug</label>
        <input id="org-slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={slugify(name) || "client-x"} className={inputCls} />
      </div>
      <div>
        <label htmlFor="org-color" className="block text-xs text-slate-400 mb-1">Colour</label>
        <input id="org-color" type="color" value={color || "#6366f1"} onChange={(e) => setColor(e.target.value)} className="h-9 w-14 bg-slate-900 border border-slate-600 rounded-lg cursor-pointer" />
      </div>
      <button
        type="submit"
        disabled={!name.trim() || !slugOk || create.isPending}
        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors"
      >
        {create.isPending ? "Creating…" : "Create"}
      </button>
      {name && !slugOk && (
        <p className="sm:col-span-4 text-xs text-amber-400">Slug: lower-case a-z, 0-9 and “-”, max 40 characters.</p>
      )}
      {create.isError && (
        <p className="sm:col-span-4 text-xs text-red-400">{errorText(create.error)}</p>
      )}
    </form>
  );
}

function OrgRow({ org }: { org: OrgWithStats }): React.ReactElement {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(org.name);
  const [color, setColor] = useState(org.color);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["orgs"] });

  const save = useMutation({
    mutationFn: () => updateOrg(org.id, { name: name.trim(), color }),
    onSuccess: () => {
      setEditing(false);
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: () => deleteOrg(org.id), onSuccess: refresh });
  const err = save.error ?? remove.error;

  return (
    <li className="py-3 border-b border-slate-700/50 last:border-b-0">
      <div className="flex items-center gap-3 flex-wrap">
        {editing ? (
          <>
            <input aria-label="Org name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className={`${inputCls} max-w-xs`} />
            <input aria-label="Org colour" type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-14 bg-slate-900 border border-slate-600 rounded-lg cursor-pointer" />
            <button onClick={() => save.mutate()} disabled={!name.trim() || save.isPending} className="px-3 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg">
              Save
            </button>
            <button onClick={() => { setEditing(false); setName(org.name); setColor(org.color); }} className="px-3 py-1.5 text-xs text-slate-400 hover:text-white">
              Cancel
            </button>
          </>
        ) : (
          <>
            <OrgBadge slug={org.slug} name={org.name} color={org.color} size="md" />
            <code className="text-xs text-slate-500">{org.id}</code>
            <span className="text-xs text-slate-500">
              {org.projectCount} project{org.projectCount === 1 ? "" : "s"} · {org.activeSessions} active
            </span>
            <div className="ml-auto flex items-center gap-2">
              <button onClick={() => setEditing(true)} className="px-3 py-1.5 text-xs text-slate-300 hover:text-white bg-slate-700/60 hover:bg-slate-700 rounded-lg">
                Edit
              </button>
              {org.id !== DEFAULT_ORG_ID && (
                <button
                  onClick={() => {
                    if (window.confirm(`Delete org "${org.name}"? Only empty orgs can be deleted.`)) remove.mutate();
                  }}
                  disabled={remove.isPending}
                  className="px-3 py-1.5 text-xs text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 rounded-lg"
                >
                  Delete
                </button>
              )}
            </div>
          </>
        )}
      </div>
      {org.apiKeyEnv && (
        <p className="mt-1 text-xs text-slate-500">
          Optional per-org API key: <code className="text-slate-400">{org.apiKeyEnv}</code>
        </p>
      )}
      {err && <p className="mt-1 text-xs text-red-400">{errorText(err)}</p>}
    </li>
  );
}

export function Settings(): React.ReactElement {
  const [showNew, setShowNew] = useState(false);
  const { data: orgs, isLoading, error } = useQuery({ queryKey: ["orgs"], queryFn: fetchOrgs });

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-xl font-bold text-white mb-6">Settings</h1>

      <section className="bg-slate-800 rounded-xl border border-slate-700/50 p-5">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-semibold text-white">Organizations</h2>
          <button
            onClick={() => setShowNew((v) => !v)}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-colors"
          >
            {showNew ? "Cancel" : "+ New Org"}
          </button>
        </div>
        <p className="text-xs text-slate-500 mb-4">
          Each org has its own projects, sessions, memory, alerts and brain — nothing crosses org boundaries.
          An org can be deleted once it owns no data.
        </p>

        {showNew && <NewOrgForm onDone={() => setShowNew(false)} />}

        {isLoading && <p className="text-sm text-slate-500">Loading…</p>}
        {error && <p className="text-sm text-red-400">Couldn't load organizations — {errorText(error)}</p>}
        {orgs && (
          <ul>
            {orgs.map((org) => (
              <OrgRow key={`${org.id}:${org.name}:${org.color}`} org={org} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
