/**
 * Phase 10 — admin review queue for LLM-suggested thought_refs.
 *
 * Pull unreviewed suggestions from the proposer queue and let the user
 * approve (insert into thought_refs) or reject (mark reviewed only).
 * Re-running the proposer is gated to one-click here.
 */

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { humanizeApiError } from "../../../lib/humanize-error";
import {
  brainAdminSuggestionsList,
  brainAdminSuggestionsRun,
  brainAdminSuggestionDecide,
  type BrainSuggestion,
} from "../../../lib/brainApi";
import { useOrgProject } from "../../../components/OrgProjectPicker";
import { useToasts, ToastStack } from "../../../components/Toast";

const RELATION_COLOURS: Record<string, string> = {
  refines: "#10b981",
  supersedes: "#f59e0b",
  contradicts: "#ef4444",
  duplicate_of: "#a855f7",
  related_to: "#3b82f6",
};

function colourFor(rel: string): string {
  return RELATION_COLOURS[rel] ?? "#64748b";
}

export function BrainAdminSuggestions(): React.ReactElement {
  const { scope } = useOrgProject();
  const { orgId, projectId } = scope;
  const [showReviewed, setShowReviewed] = useState(false);

  const [items, setItems] = useState<BrainSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<{
    pairs_examined: number;
    suggestions_created: number;
    batches_run: number;
    skipped_reason: string | null;
  } | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await brainAdminSuggestionsList({
        org_id: orgId,
        project_id: projectId || undefined,
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

  async function runProposer() {
    if (!projectId) {
      setErr("project_id is required to run the proposer");
      return;
    }
    setRunning(true);
    setErr(null);
    try {
      const r = await brainAdminSuggestionsRun({
        org_id: orgId,
        project_id: projectId,
      });
      setLastRun(r);
      await load();
    } catch (e) {
      setErr(humanizeApiError(e));
    } finally {
      setRunning(false);
    }
  }

  const { toasts, push, dismiss } = useToasts();

  async function decide(id: string, decision: "approve" | "reject") {
    const original = items.find((s) => s.id === id);
    if (!original) return;
    // Optimistic — pull the row out immediately.
    setItems((p) => p.filter((s) => s.id !== id));
    try {
      await brainAdminSuggestionDecide(id, { org_id: orgId, decision });
      push({
        kind: "success",
        message:
          decision === "approve" ? "Approved suggestion" : "Rejected suggestion",
        detail: `${original.relation} · ${(original.from_content ?? "").slice(0, 40)}…`,
        // Undo currently re-loads the queue (we don't have a server-side
        // unreview endpoint yet — adding one would be a small follow-up).
        undo: async () => {
          push({
            kind: "info",
            message:
              "Undo isn't wired server-side yet — refreshing list. " +
              "Re-run proposer if needed.",
          });
          await load();
        },
      });
    } catch (e) {
      // Roll back the optimistic removal.
      setItems((p) => [original, ...p]);
      push({
        kind: "error",
        message: `Couldn't ${decision} — try again`,
        detail: humanizeApiError(e),
      });
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, projectId, showReviewed]);

  const summary = useMemo(() => {
    const byRel = new Map<string, number>();
    for (const s of items) {
      byRel.set(s.relation, (byRel.get(s.relation) ?? 0) + 1);
    }
    return [...byRel.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);

  return (
    <div className="p-6 space-y-4 text-slate-200">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Suggestion Queue</h1>
        <span className="text-xs text-slate-500">
          {items.length} suggestion{items.length === 1 ? "" : "s"}
        </span>
      </div>
      <p className="text-sm text-slate-400">
        LLM-proposed thought references. Approve to insert into{" "}
        <code className="text-xs bg-slate-800 px-1 rounded">thought_refs</code> with
        origin <code className="text-xs bg-slate-800 px-1 rounded">llm_suggested_approved</code>.
      </p>

      <section className="bg-slate-800/40 border border-slate-800 rounded p-4 flex flex-wrap items-end gap-3">
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
          onClick={runProposer}
          disabled={running || !projectId}
          className="ml-auto px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm disabled:opacity-50"
        >
          {running ? "Running…" : "Run proposer"}
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

      {lastRun && (
        <div className="text-xs bg-slate-800/40 border border-slate-800 rounded p-3 text-slate-300">
          Last run: examined {lastRun.pairs_examined} pairs, created{" "}
          {lastRun.suggestions_created} suggestions across {lastRun.batches_run}{" "}
          batches
          {lastRun.skipped_reason ? ` — skipped: ${lastRun.skipped_reason}` : ""}
        </div>
      )}

      {err && (
        <div role="alert" className="text-red-400 bg-red-950/30 border border-red-900 p-3 rounded text-sm">
          {err}
        </div>
      )}

      {summary.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          {summary.map(([rel, n]) => (
            <span
              key={rel}
              className="flex items-center gap-1 px-2 py-1 bg-slate-800 rounded"
            >
              <span
                className="w-2 h-2 rounded-full"
                style={{ background: colourFor(rel) }}
              />
              {rel}
              <span className="text-slate-500">{n}</span>
            </span>
          ))}
        </div>
      )}

      {!loading && items.length === 0 && (
        <div className="text-slate-500 text-sm py-8 text-center">
          {showReviewed
            ? "no suggestions yet"
            : "no unreviewed suggestions — run the proposer or toggle ‘show reviewed’"}
        </div>
      )}

      <ul className="space-y-3">
        {items.map((s) => (
          <li
            key={s.id}
            className="bg-slate-800/40 border border-slate-800 rounded p-4 space-y-3"
          >
            <div className="flex items-center gap-2 text-xs">
              <span
                className="px-2 py-0.5 rounded text-white text-[10px] uppercase tracking-wide"
                style={{ background: colourFor(s.relation) }}
              >
                {s.relation}
              </span>
              <span className="text-slate-500">
                cosine {(s.cosine ?? 0).toFixed(3)} ·{" "}
                {new Date(s.created_at * 1000).toLocaleString()}
              </span>
              {s.reviewed === 1 && (
                <span className="text-amber-400">decided: {s.decision}</span>
              )}
              <span className="ml-auto font-mono text-[10px] text-slate-600">
                {s.proposer_model}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <ThoughtCard
                title={`A · ${s.from_thought_type ?? "—"}`}
                content={s.from_content}
                thoughtId={s.from_thought_id}
                orgId={orgId}
              />
              <ThoughtCard
                title={`B · ${s.to_thought_type ?? "—"}`}
                content={s.to_content}
                thoughtId={s.to_thought_id}
                orgId={orgId}
              />
            </div>

            {s.justification && (
              <div className="text-sm text-slate-300 italic">
                &ldquo;{s.justification}&rdquo;
              </div>
            )}

            {s.reviewed === 0 && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => decide(s.id, "approve")}
                  className="px-3 py-1.5 rounded bg-green-600 hover:bg-green-500 text-white text-sm"
                >
                  Approve
                </button>
                <button
                  type="button"
                  onClick={() => decide(s.id, "reject")}
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

function ThoughtCard({
  title,
  content,
  thoughtId,
  orgId,
}: {
  title: string;
  content: string | null;
  thoughtId?: string;
  orgId?: string;
}): React.ReactElement {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded p-3 text-sm">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] uppercase tracking-wide text-slate-500">
          {title}
        </span>
        {thoughtId && orgId && (
          <Link
            to={`/brain/thought/${thoughtId}?org_id=${orgId}`}
            className="text-[10px] text-blue-400 hover:underline"
          >
            open →
          </Link>
        )}
      </div>
      <div className="text-slate-200 whitespace-pre-wrap break-words text-sm">
        {content ?? "[content unavailable]"}
      </div>
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
