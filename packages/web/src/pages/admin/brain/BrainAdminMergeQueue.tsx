/**
 * Merge review queues.
 *   - Entities (Phase 10): approve sets `merged_into` lazily, reject just
 *     records the decision.
 *   - Thought near-dups (Phase 22-E): proposals from the daily embedding
 *     dedup job (cosine ≥ 0.92). Approve hides the left thought behind the
 *     right one (visibility `merged_into:<id>`, row kept); keep-both rejects.
 */

import { useEffect, useState } from "react";
import { humanizeApiError } from "../../../lib/humanize-error";
import {
  brainAdminMergeProposalsList,
  brainAdminMergeProposalDecide,
  brainAdminMergeProposalsCreate,
  brainAdminThoughtMergeProposalsList,
  brainAdminThoughtMergeProposalsRun,
  brainAdminThoughtMergeProposalDecide,
  type BrainMergeProposal,
  type BrainThoughtMergeProposal,
} from "../../../lib/brainApi";
import { useOrgProject } from "../../../components/OrgProjectPicker";
import { useToasts, ToastStack } from "../../../components/Toast";
import { EntityCombobox } from "../../../components/EntityCombobox";

type QueueTab = "entities" | "thoughts";

export function BrainAdminMergeQueue(): React.ReactElement {
  const [tab, setTab] = useState<QueueTab>("entities");
  const tabCls = (t: QueueTab) =>
    `px-3 py-1.5 rounded text-sm border ${
      tab === t
        ? "bg-slate-700 border-slate-600 text-white"
        : "bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200"
    }`;
  return (
    <div>
      <div role="tablist" className="px-6 pt-6 flex gap-2">
        <button type="button" role="tab" aria-selected={tab === "entities"} className={tabCls("entities")} onClick={() => setTab("entities")}>
          Entities
        </button>
        <button type="button" role="tab" aria-selected={tab === "thoughts"} className={tabCls("thoughts")} onClick={() => setTab("thoughts")}>
          Thought near-duplicates
        </button>
      </div>
      {tab === "entities" ? <EntityMergeQueue /> : <ThoughtNearDupQueue />}
    </div>
  );
}

function EntityMergeQueue(): React.ReactElement {
  const { scope } = useOrgProject();
  const orgId = scope.orgId;
  const [showReviewed, setShowReviewed] = useState(false);
  const [items, setItems] = useState<BrainMergeProposal[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Manual proposal form
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [rationale, setRationale] = useState("");
  const [creating, setCreating] = useState(false);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await brainAdminMergeProposalsList({
        org_id: orgId,
        reviewed: showReviewed ? undefined : false,
        limit: 200,
      });
      setItems(r.items);
    } catch (e) {
      setErr(humanizeApiError(e));
    } finally {
      setLoading(false);
    }
  }

  const { toasts, push, dismiss } = useToasts();

  async function decide(id: string, decision: "approve" | "reject") {
    const original = items.find((s) => s.id === id);
    if (!original) return;
    setItems((p) => p.filter((s) => s.id !== id));
    try {
      const r = await brainAdminMergeProposalDecide(id, {
        org_id: orgId,
        decision,
      });
      if (r.merge_error) {
        setItems((p) => [original, ...p]);
        push({
          kind: "error",
          message: "Merge couldn't apply",
          detail: r.merge_error,
        });
        return;
      }
      push({
        kind: "success",
        message:
          decision === "approve" ? "Merge approved" : "Merge rejected",
        detail:
          decision === "approve"
            ? `${original.from_canonical} → ${original.to_canonical}`
            : `${original.from_canonical} kept separate`,
      });
    } catch (e) {
      setItems((p) => [original, ...p]);
      push({
        kind: "error",
        message: `Couldn't ${decision} — try again`,
        detail: humanizeApiError(e),
      });
    }
  }

  async function create() {
    if (!fromId || !toId) {
      setErr("provide both from_entity_id and to_entity_id");
      return;
    }
    setCreating(true);
    setErr(null);
    try {
      await brainAdminMergeProposalsCreate({
        org_id: orgId,
        from_entity_id: fromId,
        to_entity_id: toId,
        rationale: rationale || undefined,
        proposer: "admin_ui",
      });
      setFromId("");
      setToId("");
      setRationale("");
      await load();
    } catch (e) {
      setErr(humanizeApiError(e));
    } finally {
      setCreating(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, showReviewed]);

  return (
    <div className="p-6 pt-4 space-y-4 text-slate-200">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Entity Merge Queue</h1>
        <span className="text-xs text-slate-500">{items.length} proposal(s)</span>
      </div>
      <p className="text-sm text-slate-400">
        Approve to lazily merge: source entity's{" "}
        <code className="text-xs bg-slate-800 px-1 rounded">merged_into</code>{" "}
        is set to target. Refs resolve through the redirect — no row rewrites.
      </p>

      <section className="bg-slate-800/40 border border-slate-800 rounded p-4 flex flex-wrap gap-3 items-end">
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={showReviewed}
            onChange={(e) => setShowReviewed(e.target.checked)}
          />
          show reviewed
        </label>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="ml-auto px-4 py-2 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm border border-slate-700 disabled:opacity-50"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </section>

      <section className="bg-slate-800/40 border border-slate-800 rounded p-4 space-y-3">
        <h2 className="text-sm font-semibold">Propose a merge</h2>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From (source — will be redirected)">
            <EntityCombobox
              value={fromId}
              onChange={(id) => setFromId(id)}
              orgId={orgId}
              excludeId={toId}
              placeholder="search entity by name…"
            />
          </Field>
          <Field label="To (target — canonical)">
            <EntityCombobox
              value={toId}
              onChange={(id) => setToId(id)}
              orgId={orgId}
              excludeId={fromId}
              placeholder="search entity by name…"
            />
          </Field>
        </div>
        <Field label="Rationale">
          <input
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            className={inputCls}
            placeholder="why this merge"
          />
        </Field>
        <button
          type="button"
          onClick={create}
          disabled={creating || !fromId || !toId}
          className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm disabled:opacity-50"
        >
          {creating ? "Creating…" : "Create proposal"}
        </button>
      </section>

      {err && (
        <div role="alert" className="text-red-400 bg-red-950/30 border border-red-900 p-3 rounded text-sm">
          {err}
        </div>
      )}

      {!loading && items.length === 0 && (
        <div className="text-slate-500 text-sm py-8 text-center">
          {showReviewed
            ? "no proposals"
            : "no unreviewed proposals — toggle ‘show reviewed’ for history"}
        </div>
      )}

      <ul className="space-y-3">
        {items.map((p) => (
          <li
            key={p.id}
            className="bg-slate-800/40 border border-slate-800 rounded p-4 space-y-3"
          >
            <div className="flex items-center gap-2 text-xs">
              <span className="px-2 py-0.5 rounded bg-amber-700 text-white text-[10px] uppercase tracking-wide">
                merge
              </span>
              <span className="text-slate-500">
                conf {p.confidence.toFixed(2)} ·{" "}
                {new Date(p.created_at * 1000).toLocaleString()} · by{" "}
                {p.proposer}
              </span>
              {p.reviewed === 1 && (
                <span className="text-amber-400">decided: {p.decision}</span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <EntityCard
                title="Source (will be redirected)"
                kind={p.from_kind}
                canonical={p.from_canonical}
                id={p.from_entity_id}
              />
              <EntityCard
                title="Target (canonical)"
                kind={p.to_kind}
                canonical={p.to_canonical}
                id={p.to_entity_id}
              />
            </div>

            {p.rationale && (
              <div className="text-sm text-slate-300 italic">
                &ldquo;{p.rationale}&rdquo;
              </div>
            )}

            {p.reviewed === 0 && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => decide(p.id, "approve")}
                  className="px-3 py-1.5 rounded bg-green-600 hover:bg-green-500 text-white text-sm"
                >
                  Approve merge
                </button>
                <button
                  type="button"
                  onClick={() => decide(p.id, "reject")}
                  className="px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm"
                >
                  Reject
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <ToastStack toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

function ThoughtNearDupQueue(): React.ReactElement {
  const { scope } = useOrgProject();
  const orgId = scope.orgId;
  const [showReviewed, setShowReviewed] = useState(false);
  const [items, setItems] = useState<BrainThoughtMergeProposal[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { toasts, push, dismiss } = useToasts();

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await brainAdminThoughtMergeProposalsList({
        org_id: orgId,
        reviewed: showReviewed ? undefined : false,
        limit: 200,
      });
      setItems(r.items);
    } catch (e) {
      setErr(humanizeApiError(e));
    } finally {
      setLoading(false);
    }
  }

  async function scan() {
    setScanning(true);
    setErr(null);
    try {
      const r = await brainAdminThoughtMergeProposalsRun({ org_id: orgId });
      push({
        kind: "success",
        message: `Scanned ${r.scanned} thought(s)`,
        detail: `${r.proposed} new proposal(s)`,
      });
      await load();
    } catch (e) {
      setErr(humanizeApiError(e));
    } finally {
      setScanning(false);
    }
  }

  async function decide(id: string, decision: "approve" | "reject") {
    const original = items.find((p) => p.id === id);
    if (!original) return;
    setItems((p) => p.filter((x) => x.id !== id));
    try {
      await brainAdminThoughtMergeProposalDecide(id, { org_id: orgId, decision });
      push({
        kind: "success",
        message: decision === "approve" ? "Duplicate hidden" : "Kept both",
      });
    } catch (e) {
      setItems((p) => [original, ...p]);
      push({
        kind: "error",
        message: `Couldn't ${decision === "approve" ? "merge" : "keep both"} — try again`,
        detail: humanizeApiError(e),
      });
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, showReviewed]);

  return (
    <div className="p-6 pt-4 space-y-4 text-slate-200">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Thought Near-Duplicates</h1>
        <span className="text-xs text-slate-500">{items.length} proposal(s)</span>
      </div>
      <p className="text-sm text-slate-400">
        Pairs with embedding similarity ≥ 0.92, found by the daily dedup job.
        Merge hides the left thought behind the right one (row kept, reversible
        via SQL); keep both just records the decision.
      </p>

      <section className="bg-slate-800/40 border border-slate-800 rounded p-4 flex flex-wrap gap-3 items-end">
        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={showReviewed}
            onChange={(e) => setShowReviewed(e.target.checked)}
          />
          show reviewed
        </label>
        <button
          type="button"
          onClick={scan}
          disabled={scanning}
          className="ml-auto px-4 py-2 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm border border-slate-700 disabled:opacity-50"
        >
          {scanning ? "Scanning…" : "Scan now"}
        </button>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="px-4 py-2 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm border border-slate-700 disabled:opacity-50"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </section>

      {err && (
        <div role="alert" className="text-red-400 bg-red-950/30 border border-red-900 p-3 rounded text-sm">
          {err}
        </div>
      )}

      {!loading && items.length === 0 && (
        <div className="text-slate-500 text-sm py-8 text-center">
          {showReviewed
            ? "no proposals"
            : "no unreviewed near-duplicates — the dedup job runs daily, or use ‘Scan now’"}
        </div>
      )}

      <ul className="space-y-3">
        {items.map((p) => (
          <li
            key={p.id}
            className="bg-slate-800/40 border border-slate-800 rounded p-4 space-y-3"
          >
            <div className="flex items-center gap-2 text-xs">
              <span className="px-2 py-0.5 rounded bg-amber-700 text-white text-[10px] uppercase tracking-wide">
                near-dup
              </span>
              <span className="text-slate-500">
                sim {p.similarity.toFixed(3)} ·{" "}
                {new Date(p.created_at * 1000).toLocaleString()} · {p.project_id}
              </span>
              {p.reviewed === 1 && (
                <span className="text-amber-400">decided: {p.decision}</span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <ThoughtCard
                title="Will be hidden on merge"
                type={p.from_type}
                content={p.from_content}
                id={p.from_thought_id}
              />
              <ThoughtCard
                title="Kept"
                type={p.to_type}
                content={p.to_content}
                id={p.to_thought_id}
              />
            </div>

            {p.reviewed === 0 && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => decide(p.id, "approve")}
                  className="px-3 py-1.5 rounded bg-green-600 hover:bg-green-500 text-white text-sm"
                >
                  Merge
                </button>
                <button
                  type="button"
                  onClick={() => decide(p.id, "reject")}
                  className="px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm"
                >
                  Keep both
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <ToastStack toasts={toasts} dismiss={dismiss} />
    </div>
  );
}

function ThoughtCard({
  title,
  type,
  content,
  id,
}: {
  title: string;
  type: string | null;
  content: string | null;
  id: string;
}): React.ReactElement {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded p-3 text-sm">
      <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
        {title}
        {type ? ` · ${type}` : ""}
      </div>
      <div className="text-slate-200 whitespace-pre-wrap break-words max-h-48 overflow-auto">
        {content ?? "[thought not found]"}
      </div>
      <div className="font-mono text-[10px] text-slate-600 mt-1 break-all">{id}</div>
    </div>
  );
}

function EntityCard({
  title,
  kind,
  canonical,
  id,
}: {
  title: string;
  kind: string | null;
  canonical: string | null;
  id: string;
}): React.ReactElement {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded p-3 text-sm">
      <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
        {title}
      </div>
      <div className="text-slate-200 font-medium">{canonical ?? "—"}</div>
      <div className="text-xs text-slate-500 mt-1">
        {kind ?? "[entity not found]"}
      </div>
      <div className="font-mono text-[10px] text-slate-600 mt-1 break-all">
        {id}
      </div>
    </div>
  );
}

const inputCls =
  "bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500 w-full";

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
