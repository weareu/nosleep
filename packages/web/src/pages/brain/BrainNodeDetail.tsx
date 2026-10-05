/**
 * Phase 22-A — sidebar detail panel for the brain graph. Replaces the
 * previous "id + kind" useless click target with a real context view:
 * project, breadcrumb, snippet, linked thoughts, topic/people/action
 * chips, click-to-navigate.
 *
 * Pulls all data from the GraphNode payload (server-enriched in
 * `buildGraph`) so the panel can render synchronously on click — no
 * round-trip per selection.
 */

import { Link } from "react-router-dom";
import type { BrainGraphNode, BrainGraphEdge } from "../../lib/brainApi";

interface BrainNodeDetailProps {
  readonly node: BrainGraphNode;
  readonly edges: readonly BrainGraphEdge[];
  readonly allNodes: readonly BrainGraphNode[];
  readonly orgId: string;
  /** Called when user clicks a related node — re-centre the graph. */
  readonly onNavigateNode: (nodeId: string) => void;
  /** Called when user clicks "Isolate" — switch graph to local mode. */
  readonly onIsolate: (nodeId: string) => void;
}

export function BrainNodeDetail({
  node,
  edges,
  allNodes,
  orgId,
  onNavigateNode,
  onIsolate,
}: BrainNodeDetailProps): React.ReactElement {
  const incoming = edges.filter((e) => e.to === node.id);
  const outgoing = edges.filter((e) => e.from === node.id);
  const nodeById = new Map(allNodes.map((n) => [n.id, n]));

  const sourceLink = (() => {
    if (node.kind === "artifact") {
      return `/brain/artifact/${node.id}?org=${orgId}`;
    }
    if (node.kind === "thought") {
      return `/brain/thought/${encodeURIComponent(node.id)}?org=${orgId}`;
    }
    if (node.kind === "entity") {
      return `/brain/entity/${encodeURIComponent(node.id)}?org=${orgId}`;
    }
    return null;
  })();

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4 bg-slate-900 text-slate-200">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <KindPill kind={node.kind} thoughtType={node.thought_type} entityKind={node.entity_kind} />
          {sourceLink && (
            <Link
              to={sourceLink}
              className="text-xs text-blue-400 hover:underline ml-auto"
            >
              open ↗
            </Link>
          )}
        </div>
        <p className="text-sm leading-snug text-slate-100 break-words whitespace-pre-wrap">
          {node.content_snippet ?? node.label}
        </p>
      </div>

      {/* Project + timestamp + degree */}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {node.project_name && (
          <>
            <dt className="text-slate-500">project</dt>
            <dd className="text-slate-300">{node.project_name}</dd>
          </>
        )}
        {node.ts && (
          <>
            <dt className="text-slate-500">when</dt>
            <dd className="text-slate-300">
              {relativeTime(node.ts)} <span className="text-slate-600">· {new Date(node.ts * 1000).toLocaleString()}</span>
            </dd>
          </>
        )}
        {node.source_kind && (
          <>
            <dt className="text-slate-500">source</dt>
            <dd className="text-slate-300 font-mono">{node.source_kind}</dd>
          </>
        )}
        {node.strategy_node_ref && (
          <>
            <dt className="text-slate-500">strategy</dt>
            <dd className="text-slate-300 font-mono break-all">{node.strategy_node_ref}</dd>
          </>
        )}
        <dt className="text-slate-500">degree</dt>
        <dd className="text-slate-300">{node.degree ?? 0} edges ({incoming.length} in / {outgoing.length} out)</dd>
        <dt className="text-slate-500">id</dt>
        <dd className="font-mono text-slate-400 text-[10px] break-all">{node.id}</dd>
      </dl>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onIsolate(node.id)}
          className="text-xs px-2 py-1 rounded bg-slate-800 border border-slate-700 hover:bg-slate-700"
          title="Show only this node + its N-hop neighbours"
        >
          Isolate (local graph)
        </button>
      </div>

      {/* Topic / people / action / dates chips (thoughts only) */}
      {node.kind === "thought" && (
        <ChipSection
          rows={[
            { label: "topics", items: node.topics ?? [], colour: "blue" },
            { label: "people", items: (node.people ?? []).map((p) => `@${p}`), colour: "purple" },
            { label: "action items", items: node.action_items ?? [], colour: "amber" },
            { label: "dates", items: node.dates_mentioned ?? [], colour: "slate" },
          ]}
        />
      )}

      {/* Linked nodes */}
      {(incoming.length > 0 || outgoing.length > 0) && (
        <div>
          <h3 className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2">
            Linked nodes
          </h3>
          {outgoing.length > 0 && (
            <EdgeList
              dir="→"
              label="outgoing"
              edges={outgoing}
              otherSide="to"
              nodeById={nodeById}
              onNavigate={onNavigateNode}
            />
          )}
          {incoming.length > 0 && (
            <EdgeList
              dir="←"
              label="incoming"
              edges={incoming}
              otherSide="from"
              nodeById={nodeById}
              onNavigate={onNavigateNode}
            />
          )}
        </div>
      )}
    </div>
  );
}

function KindPill({
  kind,
  thoughtType,
  entityKind,
}: {
  kind: BrainGraphNode["kind"];
  thoughtType?: string;
  entityKind?: string;
}): React.ReactElement {
  const text =
    kind === "thought"
      ? `thought · ${thoughtType ?? "?"}`
      : kind === "entity"
        ? `entity · ${entityKind ?? "?"}`
        : "artifact";
  const tone =
    kind === "thought"
      ? "bg-blue-950/50 text-blue-300 border border-blue-900"
      : kind === "entity"
        ? "bg-purple-950/50 text-purple-300 border border-purple-900"
        : "bg-slate-800 text-slate-400 border border-slate-700";
  return (
    <span className={`text-[10px] uppercase tracking-wider font-mono px-2 py-0.5 rounded ${tone}`}>
      {text}
    </span>
  );
}

function ChipSection({
  rows,
}: {
  rows: ReadonlyArray<{
    label: string;
    items: readonly string[];
    colour: "blue" | "purple" | "amber" | "slate";
  }>;
}): React.ReactElement | null {
  const hasContent = rows.some((r) => r.items.length > 0);
  if (!hasContent) return null;
  const tone: Record<string, string> = {
    blue: "bg-blue-950/40 text-blue-300 border border-blue-900",
    purple: "bg-purple-950/40 text-purple-300 border border-purple-900",
    amber: "bg-amber-950/40 text-amber-300 border border-amber-900",
    slate: "bg-slate-800 text-slate-400 border border-slate-700",
  };
  return (
    <div className="space-y-2">
      {rows
        .filter((r) => r.items.length > 0)
        .map((r) => (
          <div key={r.label}>
            <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">
              {r.label}
            </div>
            <div className="flex flex-wrap gap-1">
              {r.items.map((it) => (
                <span
                  key={it}
                  className={`text-[10px] px-1.5 py-0.5 rounded ${tone[r.colour]}`}
                >
                  {it}
                </span>
              ))}
            </div>
          </div>
        ))}
    </div>
  );
}

function EdgeList({
  dir,
  label,
  edges,
  otherSide,
  nodeById,
  onNavigate,
}: {
  dir: string;
  label: string;
  edges: readonly BrainGraphEdge[];
  otherSide: "from" | "to";
  nodeById: Map<string, BrainGraphNode>;
  onNavigate: (id: string) => void;
}): React.ReactElement {
  return (
    <div className="space-y-0.5 mb-3">
      <div className="text-[10px] text-slate-500 mb-1">
        {dir} {label} ({edges.length})
      </div>
      {edges.slice(0, 25).map((e, i) => {
        const otherId = otherSide === "to" ? e.to : e.from;
        const other = nodeById.get(otherId);
        if (!other) return null;
        const previewText = other.content_snippet ?? other.label;
        const preview =
          previewText.length > 60 ? `${previewText.slice(0, 60)}…` : previewText;
        return (
          <button
            key={`${otherId}-${i}`}
            type="button"
            onClick={() => onNavigate(otherId)}
            className="w-full text-left text-xs px-2 py-1 rounded hover:bg-slate-800 flex items-baseline gap-2"
          >
            <span className="text-slate-600 text-[10px] font-mono w-12 flex-shrink-0">
              {e.relation}
            </span>
            <span className="text-slate-300 truncate">{preview}</span>
            <span className="text-slate-700 text-[10px] ml-auto flex-shrink-0">
              w={e.weight.toFixed(2)}
            </span>
          </button>
        );
      })}
      {edges.length > 25 && (
        <div className="text-[10px] text-slate-600 pl-2">
          … and {edges.length - 25} more
        </div>
      )}
    </div>
  );
}

function relativeTime(unixSec: number): string {
  const ms = Date.now() - unixSec * 1000;
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(unixSec * 1000).toLocaleDateString();
}
