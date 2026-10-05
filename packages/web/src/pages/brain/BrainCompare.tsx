/**
 * Brain Compare — side-by-side view of two artifacts. Renders metadata for
 * each and a simple line-level diff when both sides are text.
 *
 * URL: /brain/compare?a=<hash>&b=<hash>&org_id=<id>
 */

import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { humanizeApiError } from "../../lib/humanize-error";
import {
  brainGetArtifact,
  type BrainArtifact as BrainArtifactT,
} from "../../lib/brainApi";

const DEFAULT_ORG = "org_personal";

interface DiffLine {
  kind: "ctx" | "add" | "del";
  text: string;
}

interface DiffResult {
  left: DiffLine[];
  right: DiffLine[];
}

interface WorkerTooLargeMessage {
  type: "too_large";
  limitCells: number;
}
interface WorkerResultMessage {
  type: "result";
  left: DiffLine[];
  right: DiffLine[];
}

function isText(a: BrainArtifactT): boolean {
  if (a.content_encoding !== "utf8") return false;
  if (a.content === null) return false;
  return true;
}

export function BrainCompare(): React.ReactElement {
  const [params, setParams] = useSearchParams();
  const orgId = params.get("org") ?? params.get("org_id") ?? DEFAULT_ORG;
  const [aHash, setAHash] = useState(params.get("a") ?? "");
  const [bHash, setBHash] = useState(params.get("b") ?? "");

  const [aArt, setAArt] = useState<BrainArtifactT | null>(null);
  const [bArt, setBArt] = useState<BrainArtifactT | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Phase 12 (UI review L1) — diff is computed in a Web Worker so the
  // main thread stays responsive during compute. State machine:
  //   idle → diffing → done | too_large | non_text
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [diffStatus, setDiffStatus] = useState<
    "idle" | "diffing" | "done" | "too_large" | "non_text"
  >("idle");
  const [diffLimitCells, setDiffLimitCells] = useState<number | null>(null);

  useEffect(() => {
    if (!aHash && !bHash) return;
    setLoading(true);
    setErr(null);
    Promise.all([
      aHash ? brainGetArtifact(aHash, orgId, []) : Promise.resolve(null),
      bHash ? brainGetArtifact(bHash, orgId, []) : Promise.resolve(null),
    ])
      .then(([a, b]) => {
        setAArt(a);
        setBArt(b);
      })
      .catch((e) => setErr(humanizeApiError(e)))
      .finally(() => setLoading(false));
  }, [aHash, bHash, orgId]);

  // Run the diff in a Web Worker whenever both sides are ready.
  useEffect(() => {
    setDiff(null);
    setDiffLimitCells(null);
    if (!aArt || !bArt) {
      setDiffStatus("idle");
      return;
    }
    if (!isText(aArt) || !isText(bArt)) {
      setDiffStatus("non_text");
      return;
    }
    setDiffStatus("diffing");

    let worker: Worker | null = null;
    try {
      worker = new Worker(
        new URL("../../workers/lcs-diff.worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch {
      // Workers unavailable (test env, etc.) — show a "diff too large"
      // hint so the user knows to open each artifact directly. We do NOT
      // fall back to main-thread compute since that's the regression we
      // were fixing.
      setDiffStatus("too_large");
      return;
    }

    worker.onmessage = (
      e: MessageEvent<WorkerTooLargeMessage | WorkerResultMessage>,
    ) => {
      if (e.data.type === "too_large") {
        setDiffStatus("too_large");
        setDiffLimitCells(e.data.limitCells);
      } else if (e.data.type === "result") {
        setDiff({ left: e.data.left, right: e.data.right });
        setDiffStatus("done");
      }
      worker?.terminate();
    };
    worker.onerror = () => {
      setDiffStatus("too_large");
      worker?.terminate();
    };
    worker.postMessage({
      type: "diff",
      a: aArt.content ?? "",
      b: bArt.content ?? "",
    });

    return () => {
      worker?.terminate();
    };
  }, [aArt, bArt]);

  function applyHashes(e: React.FormEvent) {
    e.preventDefault();
    const next = new URLSearchParams(params);
    next.set("a", aHash);
    next.set("b", bHash);
    next.set("org", orgId);
    setParams(next);
  }

  function swap() {
    setAHash(bHash);
    setBHash(aHash);
  }

  return (
    <div className="p-6 space-y-4 text-slate-200">
      <h1 className="text-2xl font-bold">Compare</h1>

      <form
        onSubmit={applyHashes}
        className="flex flex-wrap gap-3 items-end bg-slate-800/50 p-4 rounded-lg"
      >
        <Field label="Hash A">
          <input
            value={aHash}
            onChange={(e) => setAHash(e.target.value)}
            className={`${inputCls} w-72 font-mono`}
            placeholder="sha256…"
          />
        </Field>
        <Field label="Hash B">
          <input
            value={bHash}
            onChange={(e) => setBHash(e.target.value)}
            className={`${inputCls} w-72 font-mono`}
            placeholder="sha256…"
          />
        </Field>
        <button
          type="button"
          onClick={swap}
          aria-label="Swap A and B"
          className="px-3 py-2 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm border border-slate-700"
        >
          <span aria-hidden="true">↔</span> swap
        </button>
        <button
          type="submit"
          className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-500 text-white text-sm"
        >
          Compare
        </button>
      </form>

      {err && (
        <div role="alert" className="text-red-400 bg-red-950/30 border border-red-900 p-3 rounded text-sm">
          {err}
        </div>
      )}

      {loading && (
        <div className="text-slate-500 text-sm">loading…</div>
      )}

      {(aArt || bArt) && (
        <div className="grid grid-cols-2 gap-3">
          <ArtifactPanel art={aArt} orgId={orgId} side="A" />
          <ArtifactPanel art={bArt} orgId={orgId} side="B" />
        </div>
      )}

      {diffStatus === "diffing" && (
        <div
          className="text-xs text-slate-400 bg-slate-800/40 border border-slate-700 rounded p-3 flex items-center gap-2"
          role="status"
          aria-live="polite"
        >
          <span
            className="inline-block w-3 h-3 rounded-full bg-blue-400 animate-pulse"
            aria-hidden="true"
          />
          Computing diff in background…
        </div>
      )}

      {diffStatus === "done" && diff && (
        <section>
          <h2 className="text-sm font-semibold mb-2">Diff (line-level)</h2>
          <div className="grid grid-cols-2 gap-3 font-mono text-xs">
            <DiffPanel lines={diff.left} side="left" />
            <DiffPanel lines={diff.right} side="right" />
          </div>
        </section>
      )}

      {diffStatus === "non_text" && (
        <div
          className="text-xs text-amber-300 bg-amber-950/30 border border-amber-900 rounded p-3"
          role="status"
        >
          Diff omitted — at least one artifact is non-text.
        </div>
      )}

      {diffStatus === "too_large" && (
        <div
          className="text-xs text-amber-300 bg-amber-950/30 border border-amber-900 rounded p-3"
          role="status"
        >
          Diff too large to compute in-browser
          {diffLimitCells !== null && (
            <> (limit {(diffLimitCells / 1_000_000).toFixed(0)}M cells)</>
          )}
          . Open each artifact directly to inspect.
        </div>
      )}
    </div>
  );
}

function ArtifactPanel({
  art,
  orgId,
  side,
}: {
  art: BrainArtifactT | null;
  orgId: string;
  side: "A" | "B";
}): React.ReactElement {
  return (
    <section className="bg-slate-800/40 border border-slate-800 rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-slate-400">
          Side {side}
        </span>
        {art && (
          <Link
            to={`/brain/artifact/${art.hash}?org_id=${orgId}`}
            className="text-xs text-blue-400 hover:underline ml-auto"
          >
            open →
          </Link>
        )}
      </div>
      {!art ? (
        <div className="text-xs text-slate-500">no artifact selected</div>
      ) : (
        <>
          <div className="font-mono text-xs text-slate-500 break-all">{art.hash}</div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Meta label="kind" value={art.kind} />
            <Meta label="ts" value={new Date(art.ts * 1000).toLocaleString()} />
            <Meta label="project" value={art.project_id} />
            <Meta label="size" value={`${art.size} bytes`} />
            <Meta label="content_type" value={art.content_type ?? "—"} />
            <Meta label="actor" value={art.origin.actor ?? "—"} />
          </div>
          <pre className="bg-slate-950 border border-slate-800 p-2 rounded overflow-x-auto text-[11px] whitespace-pre-wrap max-h-64">
            {art.content_encoding === "base64"
              ? "[binary content]"
              : (art.content ?? "").slice(0, 4000)}
          </pre>
        </>
      )}
    </section>
  );
}

function DiffPanel({
  lines,
  side,
}: {
  lines: DiffLine[];
  side: "left" | "right";
}): React.ReactElement {
  return (
    <pre className="bg-slate-950 border border-slate-800 p-2 rounded overflow-x-auto whitespace-pre-wrap leading-relaxed">
      {lines.map((l, idx) => {
        const baseCls =
          l.kind === "del"
            ? "bg-red-950/40 text-red-300"
            : l.kind === "add"
              ? "bg-green-950/40 text-green-300"
              : "text-slate-400";
        const prefix =
          l.kind === "del" ? "-" : l.kind === "add" ? "+" : l.text === "" ? " " : " ";
        return (
          <div key={`${side}-${idx}`} className={`${baseCls} px-1`}>
            <span className="opacity-60 mr-2 select-none">{prefix}</span>
            {l.text || " "}
          </div>
        );
      })}
    </pre>
  );
}

function Meta({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}): React.ReactElement {
  return (
    <div>
      <div className="uppercase tracking-wide text-[10px] text-slate-500">
        {label}
      </div>
      <div className="text-slate-200">{value}</div>
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
