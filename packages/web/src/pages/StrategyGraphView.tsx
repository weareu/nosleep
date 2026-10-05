/**
 * Phase 22-C — strategy graph view. Same d3-force pattern as BrainGraph,
 * but seeded with strategy nodes + their parent/dependency/ref edges.
 *
 * Scope: project or org. Side panel = node detail + ref-add UI.
 * Edge colours: parent=slate, dependency=amber, ref=blue. Node colour
 * by project so cross-project refs are visually obvious.
 *
 * Built leaning on what already works in BrainGraph (zoom, drag, LOD)
 * to keep this focused. The renderer is intentionally similar so any
 * future Phase D (3D + clusters) lift can apply to both.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from "d3-zoom";
import { drag as d3drag } from "d3-drag";
import { select } from "d3-selection";
import {
  fetchOrgs,
  fetchProjects,
  fetchStrategyGraph,
  fetchStrategyNodeRefs,
  fetchStrategyNodePlan,
  createStrategyRef,
  deleteStrategyRef,
  type OrgWithStats,
  type ProjectRow,
  type StrategyGraphNode,
  type StrategyGraphEdge,
  type StrategyRefKind,
} from "../lib/api";
import { cullLabels, fitTransform } from "../lib/graph-view";

interface SimNode extends StrategyGraphNode, SimulationNodeDatum {
  fx?: number | null;
  fy?: number | null;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  source: SimNode | string;
  target: SimNode | string;
  edge_kind: "parent" | "dependency" | "ref";
  relation?: string;
  weight: number;
}

const STATUS_FILL: Record<string, string> = {
  pending: "#64748b",
  in_progress: "#3b82f6",
  completed: "#10b981",
  blocked: "#ef4444",
  skipped: "#475569",
};

const EDGE_COLOUR: Record<string, string> = {
  parent: "#475569",
  dependency: "#f59e0b",
  ref: "#3b82f6",
};

/** Node radius (graph units) by hierarchy level. */
function radiusFor(type: string): number {
  if (type === "strategy") return 13;
  if (type === "goal") return 10;
  if (type === "task") return 7;
  return 5;
}

/** Label priority: higher hierarchy first, then shallower depth. */
function labelPriority(n: StrategyGraphNode): number {
  const typeRank = n.type === "strategy" ? 3 : n.type === "goal" ? 2 : n.type === "task" ? 1 : 0;
  return typeRank * 100 - n.depth;
}

function labelText(n: StrategyGraphNode): string {
  return n.title.length > 28 ? n.title.slice(0, 26) + "…" : n.title;
}

const LABEL_FONT_PX = 11;

// Stable per-project ring colour for visual cluster separation.
function projectRingColour(projectId: string): string {
  const palette = [
    "#a78bfa",
    "#34d399",
    "#fb923c",
    "#f472b6",
    "#facc15",
    "#22d3ee",
    "#f87171",
    "#a3e635",
    "#fbbf24",
    "#c084fc",
  ];
  let h = 0;
  for (let i = 0; i < projectId.length; i++) h = (h * 31 + projectId.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length];
}

export function StrategyGraphView(): React.ReactElement {
  const queryClient = useQueryClient();
  const [scopeMode, setScopeMode] = useState<"project" | "org">("project");
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selected, setSelected] = useState<StrategyGraphNode | null>(null);
  const [zoomScale, setZoomScale] = useState(1);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const transformRef = useRef<ZoomTransform>(zoomIdentity);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const userMovedViewRef = useRef(false);
  const selectedIdRef = useRef<string | null>(null);

  const { data: orgs } = useQuery<OrgWithStats[]>({
    queryKey: ["orgs"],
    queryFn: fetchOrgs,
  });
  const { data: projects } = useQuery<ProjectRow[]>({
    queryKey: ["projects", selectedOrgId],
    queryFn: () => fetchProjects(selectedOrgId ?? undefined),
    enabled: !!selectedOrgId,
  });

  // Initialise to first org once orgs load.
  useEffect(() => {
    if (orgs && orgs.length > 0 && !selectedOrgId) {
      setSelectedOrgId(orgs[0].id);
    }
  }, [orgs, selectedOrgId]);

  const graphQuery = useQuery({
    queryKey: ["strategy-graph", scopeMode, selectedOrgId, selectedProjectId],
    queryFn: () =>
      fetchStrategyGraph({
        orgId: scopeMode === "org" ? selectedOrgId ?? undefined : undefined,
        projectId: scopeMode === "project" ? selectedProjectId ?? undefined : undefined,
        limit: 600,
      }),
    enabled:
      (scopeMode === "org" && !!selectedOrgId) ||
      (scopeMode === "project" && !!selectedProjectId),
  });
  const data = graphQuery.data;

  // d3 sim
  useEffect(() => {
    if (!svgRef.current || !data) return;
    const width = svgRef.current.clientWidth || 900;
    const height = svgRef.current.clientHeight || 600;
    const nodes: SimNode[] = data.nodes.map((n) => ({ ...n }));
    const links: SimLink[] = data.edges
      .filter(
        (e) =>
          nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to),
      )
      .map((e) => ({
        source: e.from,
        target: e.to,
        edge_kind: e.kind,
        relation: e.relation,
        weight: e.weight,
      }));

    if (simRef.current) simRef.current.stop();
    const sim = forceSimulation<SimNode>(nodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance((l) =>
            l.edge_kind === "parent" ? 50 : l.edge_kind === "ref" ? 90 : 70,
          )
          .strength((l) =>
            l.edge_kind === "parent" ? 0.7 : l.edge_kind === "ref" ? 0.3 : 0.5,
          ),
      )
      .force("charge", forceManyBody<SimNode>().strength(-150))
      .force("center", forceCenter<SimNode>(width / 2, height / 2))
      .force(
        "collide",
        forceCollide<SimNode>().radius((d) => radiusFor(d.type) + 6),
      )
      .alphaDecay(0.04);
    simRef.current = sim;
    nodesRef.current = nodes;

    const svg = select(svgRef.current);
    svg.selectAll("*").remove();
    const g = svg.append("g");

    const zoomBehaviour = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 5])
      .on("zoom", (event) => {
        transformRef.current = event.transform;
        if (event.sourceEvent) userMovedViewRef.current = true;
        g.attr("transform", event.transform.toString());
        setZoomScale(event.transform.k);
        refreshLabels();
      });
    zoomRef.current = zoomBehaviour;
    userMovedViewRef.current = false;
    svg.call(zoomBehaviour as never).call(
      (s) => s.call(zoomBehaviour.transform as never, zoomIdentity),
    );

    // Edges
    const linkSel = g
      .append("g")
      .attr("class", "edges")
      .selectAll("line")
      .data(links)
      .enter()
      .append("line")
      .attr("stroke", (d) => EDGE_COLOUR[d.edge_kind] ?? "#475569")
      .attr("stroke-opacity", (d) =>
        d.edge_kind === "ref" ? 0.8 : d.edge_kind === "dependency" ? 0.7 : 0.4,
      )
      .attr("stroke-width", (d) =>
        d.edge_kind === "ref" ? 1.5 : d.edge_kind === "parent" ? 0.8 : 1.2,
      )
      .attr("stroke-dasharray", (d) => (d.edge_kind === "ref" ? "4,2" : null));

    // Nodes
    const nodeSel = g
      .append("g")
      .attr("class", "nodes")
      .selectAll("circle")
      .data(nodes)
      .enter()
      .append("circle")
      .attr("r", (d) => radiusFor(d.type))
      .attr("fill", (d) => STATUS_FILL[d.status] ?? "#64748b")
      .attr("stroke", (d) => projectRingColour(d.project_id))
      .attr("stroke-width", 2.5)
      .style("cursor", "pointer")
      .on("click", (_e, d) => setSelected(d as StrategyGraphNode));

    nodeSel
      .append("title")
      .text((d) => `${d.title} — ${d.status.replace("_", " ")} · ${d.progress_pct}% (${d.project_name})`);

    // Labels — collision-culled by hierarchy (strategy > goal > task) at
    // every zoom; refreshLabels() decides which fit without overlapping.
    const labelSel = g
      .append("g")
      .attr("class", "labels")
      .attr("pointer-events", "none")
      .selectAll("text")
      .data(nodes)
      .enter()
      .append("text")
      .attr("fill", "#e2e8f0")
      .attr("paint-order", "stroke")
      .attr("stroke", "#0b1220")
      .style("display", "none")
      .text((d) => labelText(d));

    const dragBehaviour = d3drag<SVGCircleElement, SimNode>()
      .on("start", (event, d) => {
        if (!event.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event, d) => {
        if (!event.active) sim.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });
    nodeSel.call(dragBehaviour as never);

    let tickCount = 0;
    sim.on("tick", () => {
      linkSel
        .attr("x1", (d) => (d.source as SimNode).x ?? 0)
        .attr("y1", (d) => (d.source as SimNode).y ?? 0)
        .attr("x2", (d) => (d.target as SimNode).x ?? 0)
        .attr("y2", (d) => (d.target as SimNode).y ?? 0);
      nodeSel.attr("cx", (d) => d.x ?? 0).attr("cy", (d) => d.y ?? 0);
      labelSel.attr("x", (d) => d.x ?? 0).attr("y", (d) => d.y ?? 0);
      if (++tickCount % 8 === 0) {
        // Keep the whole tree framed while it settles (until the user takes over).
        if (!userMovedViewRef.current) fitView();
        refreshLabels();
      }
    });
    sim.on("end", () => {
      if (!userMovedViewRef.current) fitView();
      refreshLabels();
    });

    return () => {
      sim.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  function refreshLabels(): void {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const t = transformRef.current;
    const k = t.k;
    const sel = selectedIdRef.current;
    const shown = cullLabels(
      nodesRef.current.map((n) => ({
        id: n.id,
        x: t.applyX(n.x ?? 0),
        y: t.applyY(n.y ?? 0),
        text: labelText(n),
        priority: labelPriority(n),
        pinned: n.id === sel,
        offsetX: radiusFor(n.type) * k + 4,
      })),
      { width: svgEl.clientWidth || 900, height: svgEl.clientHeight || 600 },
      { charWidth: LABEL_FONT_PX * 0.6, lineHeight: LABEL_FONT_PX + 3 },
    );
    select(svgEl)
      .select("g.labels")
      .selectAll<SVGTextElement, SimNode>("text")
      .attr("font-size", LABEL_FONT_PX / k)
      .attr("stroke-width", 3 / k)
      .attr("dx", (d) => radiusFor(d.type) + 4 / k)
      .attr("dy", (LABEL_FONT_PX * 0.35) / k)
      .style("display", (d) => (shown.has(d.id) ? null : "none"));
  }

  function fitView(): void {
    const svgEl = svgRef.current;
    const zoomBehaviour = zoomRef.current;
    if (!svgEl || !zoomBehaviour) return;
    const fit = fitTransform(
      nodesRef.current,
      { width: svgEl.clientWidth, height: svgEl.clientHeight },
      { padding: 60, minScale: 0.15, maxScale: 1.5 },
    );
    if (!fit) return;
    select(svgEl).call(
      zoomBehaviour.transform as never,
      zoomIdentity.translate(fit.x, fit.y).scale(fit.k),
    );
  }

  useEffect(() => {
    selectedIdRef.current = selected?.id ?? null;
    refreshLabels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // Re-fit when the canvas resizes (detail panel opens/closes, window resize).
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl || typeof ResizeObserver === "undefined") return;
    let last = { w: svgEl.clientWidth, h: svgEl.clientHeight };
    let timer: number | undefined;
    const ro = new ResizeObserver(() => {
      const w = svgEl.clientWidth;
      const h = svgEl.clientHeight;
      if (w === last.w && h === last.h) return;
      last = { w, h };
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        fitView();
        refreshLabels();
      }, 80);
    });
    ro.observe(svgEl);
    return () => {
      window.clearTimeout(timer);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refQuery = useQuery({
    queryKey: ["strategy-refs", selected?.id],
    queryFn: () => (selected ? fetchStrategyNodeRefs(selected.id) : Promise.resolve(null)),
    enabled: !!selected,
  });

  const totalEdgesByKind = useMemo(() => {
    if (!data) return { parent: 0, dependency: 0, ref: 0 };
    return data.edges.reduce(
      (acc, e) => {
        acc[e.kind] = (acc[e.kind] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    );
  }, [data]);

  return (
    <div className="flex flex-col h-full text-slate-200">
      {/* Header / scope picker */}
      <div className="p-3 border-b border-slate-800 bg-slate-900 flex flex-wrap items-center gap-3">
        <h1 className="text-sm font-semibold text-slate-300">Strategy Graph</h1>
        <div className="flex rounded border border-slate-700 overflow-hidden">
          {(["project", "org"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setScopeMode(m)}
              className={`px-3 py-1 text-xs ${
                scopeMode === m
                  ? "bg-blue-600 text-white"
                  : "bg-slate-900 text-slate-400 hover:text-slate-200"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <select
          value={selectedOrgId ?? ""}
          onChange={(e) => {
            setSelectedOrgId(e.target.value || null);
            setSelectedProjectId(null);
          }}
          className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200"
        >
          <option value="">(org)</option>
          {orgs?.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        {scopeMode === "project" && (
          <select
            value={selectedProjectId ?? ""}
            onChange={(e) => setSelectedProjectId(e.target.value || null)}
            disabled={!selectedOrgId}
            className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 disabled:opacity-50"
          >
            <option value="">(project)</option>
            {projects?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {data && (
          <span className="text-[10px] text-slate-500 ml-auto">
            {data.nodes.length} nodes · {data.edges.length} edges
            ({totalEdgesByKind.parent ?? 0}p / {totalEdgesByKind.dependency ?? 0}d / {totalEdgesByKind.ref ?? 0}r)
            · zoom {zoomScale.toFixed(2)}×
          </span>
        )}
      </div>

      {/* Legend */}
      <div className="px-3 py-2 border-b border-slate-800 bg-slate-900/60 flex items-center gap-4 text-[10px] text-slate-500">
        <span>edges:</span>
        <LegendDot colour={EDGE_COLOUR.parent} label="parent (solid thin)" />
        <LegendDot colour={EDGE_COLOUR.dependency} label="dependency (solid)" />
        <LegendDot colour={EDGE_COLOUR.ref} label="ref (dashed)" />
        <span className="ml-4">status:</span>
        {Object.entries(STATUS_FILL).map(([s, c]) => (
          <LegendDot key={s} colour={c} label={s} />
        ))}
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 relative">
          <svg ref={svgRef} className="w-full h-full" style={{ background: "#0b1220" }} />
          {graphQuery.isLoading && (
            <div className="absolute top-3 left-3 text-xs text-slate-400 bg-slate-900/80 px-2 py-1 rounded">
              loading…
            </div>
          )}
          {!data?.nodes.length && !graphQuery.isLoading && (
            <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-sm">
              {scopeMode === "project" && !selectedProjectId
                ? "pick a project"
                : "no nodes in this scope"}
            </div>
          )}
        </div>

        {selected && (
          <aside className="w-96 flex-shrink-0 border-l border-slate-800 overflow-y-auto p-4 space-y-4 bg-slate-900">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-widest text-slate-500">
                {selected.type} · {selected.status}
              </span>
              <button
                onClick={() => setSelected(null)}
                className="text-slate-500 hover:text-slate-200 text-sm"
                type="button"
              >
                ×
              </button>
            </div>
            <h2 className="text-sm font-semibold text-slate-100 break-words">
              {selected.title}
            </h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-slate-500">project</dt>
              <dd className="text-slate-300">{selected.project_name}</dd>
              <dt className="text-slate-500">progress</dt>
              <dd className="text-slate-300">{selected.progress_pct}%</dd>
              <dt className="text-slate-500">depth</dt>
              <dd className="text-slate-300">{selected.depth}</dd>
              <dt className="text-slate-500">id</dt>
              <dd className="font-mono text-slate-400 text-[10px] break-all">
                {selected.id}
              </dd>
            </dl>

            <RefSection
              node={selected}
              refs={refQuery.data}
              allNodes={data?.nodes ?? []}
              onChange={() => {
                queryClient.invalidateQueries({ queryKey: ["strategy-refs", selected.id] });
                queryClient.invalidateQueries({ queryKey: ["strategy-graph"] });
              }}
              onNavigateNode={(id) => {
                const next = (data?.nodes ?? []).find((n) => n.id === id);
                if (next) setSelected(next);
              }}
            />
          </aside>
        )}
      </div>
    </div>
  );
}

function LegendDot({ colour, label }: { colour: string; label: string }): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="w-2 h-2 rounded-full" style={{ background: colour }} />
      {label}
    </span>
  );
}

function RefSection({
  node,
  refs,
  allNodes,
  onChange,
  onNavigateNode,
}: {
  node: StrategyGraphNode;
  refs: { outgoing: Array<{ id: string; to_id: string; kind: string; weight: number; to_title: string; to_project_name: string; to_status: string }>; incoming: Array<{ id: string; from_id: string; kind: string; weight: number; from_title: string; from_project_name: string; from_status: string }> } | null | undefined;
  allNodes: readonly StrategyGraphNode[];
  onChange: () => void;
  onNavigateNode: (id: string) => void;
}): React.ReactElement {
  const [addOpen, setAddOpen] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);
  const [refKind, setRefKind] = useState<StrategyRefKind>("related");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [planOpen, setPlanOpen] = useState(false);

  const searchHits = useMemo(() => {
    if (!searchInput.trim()) return [];
    const q = searchInput.toLowerCase();
    return allNodes
      .filter((n) => n.id !== node.id && n.title.toLowerCase().includes(q))
      .slice(0, 8);
  }, [searchInput, allNodes, node.id]);

  const handleAdd = async () => {
    if (!selectedTarget) return;
    setBusy(true);
    setErr(null);
    try {
      await createStrategyRef({ fromId: node.id, toId: selectedTarget, kind: refKind });
      setAddOpen(false);
      setSelectedTarget(null);
      setSearchInput("");
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (refId: string) => {
    setBusy(true);
    try {
      await deleteStrategyRef(refId);
      onChange();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <button
          type="button"
          onClick={() => setPlanOpen(true)}
          className="w-full text-xs px-2 py-1.5 rounded bg-slate-800 border border-slate-700 hover:bg-slate-700 text-slate-200"
        >
          📄 View plan doc
        </button>
      </div>

      {planOpen && <PlanModal nodeId={node.id} onClose={() => setPlanOpen(false)} />}

      <div className="flex items-baseline justify-between">
        <h3 className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
          Ref-links
        </h3>
        <button
          type="button"
          onClick={() => setAddOpen((o) => !o)}
          className="text-[10px] text-blue-400 hover:underline"
        >
          {addOpen ? "cancel" : "+ add"}
        </button>
      </div>

      {addOpen && (
        <div className="bg-slate-950 border border-slate-800 rounded p-2 space-y-2">
          <input
            type="search"
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              setSelectedTarget(null);
            }}
            placeholder="search node title…"
            className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs"
          />
          {searchHits.length > 0 && !selectedTarget && (
            <div className="max-h-32 overflow-y-auto space-y-0.5">
              {searchHits.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => setSelectedTarget(h.id)}
                  className="w-full text-left text-xs px-2 py-1 rounded hover:bg-slate-800"
                >
                  <span className="text-slate-400">{h.project_name}: </span>
                  <span className="text-slate-200">{h.title}</span>
                </button>
              ))}
            </div>
          )}
          {selectedTarget && (
            <div className="text-[10px] text-slate-400 font-mono break-all">
              → {selectedTarget}
            </div>
          )}
          <select
            value={refKind}
            onChange={(e) => setRefKind(e.target.value as StrategyRefKind)}
            className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs"
          >
            <option value="related">related</option>
            <option value="informs">informs</option>
            <option value="supersedes">supersedes</option>
            <option value="references">references</option>
          </select>
          <button
            type="button"
            onClick={handleAdd}
            disabled={!selectedTarget || busy}
            className="w-full text-xs px-2 py-1 rounded bg-blue-600 disabled:opacity-40 text-white"
          >
            {busy ? "saving…" : "create link"}
          </button>
          {err && <div className="text-[10px] text-red-400">{err}</div>}
        </div>
      )}

      {refs && (refs.outgoing.length > 0 || refs.incoming.length > 0) ? (
        <>
          {refs.outgoing.length > 0 && (
            <div>
              <div className="text-[10px] text-slate-500 mb-1">
                Outgoing ({refs.outgoing.length})
              </div>
              {refs.outgoing.map((r) => (
                <RefRow
                  key={r.id}
                  refId={r.id}
                  kind={r.kind as StrategyRefKind}
                  weight={r.weight}
                  title={r.to_title}
                  status={r.to_status}
                  project={r.to_project_name}
                  targetId={r.to_id}
                  onNavigate={onNavigateNode}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}
          {refs.incoming.length > 0 && (
            <div>
              <div className="text-[10px] text-slate-500 mb-1">
                Incoming ({refs.incoming.length})
              </div>
              {refs.incoming.map((r) => (
                <RefRow
                  key={r.id}
                  refId={r.id}
                  kind={r.kind as StrategyRefKind}
                  weight={r.weight}
                  title={r.from_title}
                  status={r.from_status}
                  project={r.from_project_name}
                  targetId={r.from_id}
                  inbound
                  onNavigate={onNavigateNode}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="text-[10px] text-slate-600">(no ref-links yet)</div>
      )}
    </div>
  );
}

function PlanModal({
  nodeId,
  onClose,
}: {
  nodeId: string;
  onClose: () => void;
}): React.ReactElement {
  const { data, isLoading, error } = useQuery({
    queryKey: ["strategy-node-plan", nodeId],
    queryFn: () => fetchStrategyNodePlan(nodeId),
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-slate-900 border border-slate-700 rounded-xl max-w-4xl max-h-[85vh] w-full overflow-hidden flex flex-col"
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-800">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-200 truncate">
              {data?.nodeTitle ?? "Loading…"}
            </div>
            {data?.filePath && (
              <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                {data.filePath}
                {data.lineNumber ? `:L${data.lineNumber}` : ""} · {data.projectName}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-slate-500 hover:text-white px-1"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-auto bg-slate-950 p-4 font-mono text-xs text-slate-200 whitespace-pre-wrap leading-5">
          {isLoading && <span className="text-slate-500">loading plan…</span>}
          {error && (
            <span className="text-red-400">
              Failed: {error instanceof Error ? error.message : String(error)}
            </span>
          )}
          {data?.missing && (
            <div className="text-amber-300">
              {data.message ?? "No plan linked to this node yet."}
              <div className="text-[10px] text-slate-500 mt-3">
                To link a plan, either set <code>source_ref</code> directly on
                the node (e.g. <code>docs/plans/foo.md:L10</code>) or run the
                plan indexer so FTS can find a match by title.
              </div>
            </div>
          )}
          {data?.content && data.content}
        </div>
      </div>
    </div>
  );
}

function RefRow({
  refId,
  kind,
  weight,
  title,
  status,
  project,
  targetId,
  inbound,
  onNavigate,
  onDelete,
}: {
  refId: string;
  kind: StrategyRefKind;
  weight: number;
  title: string;
  status: string;
  project: string;
  targetId: string;
  inbound?: boolean;
  onNavigate: (id: string) => void;
  onDelete: (id: string) => void;
}): React.ReactElement {
  return (
    <div className="flex items-baseline gap-2 text-xs py-0.5">
      <span className="text-[10px] uppercase tracking-wider text-blue-400 font-mono w-20 flex-shrink-0">
        {inbound ? "← " : "→ "}{kind}
      </span>
      <button
        type="button"
        onClick={() => onNavigate(targetId)}
        className="text-slate-300 hover:text-blue-400 hover:underline text-left flex-1 truncate"
        title={`${project}: ${title}`}
      >
        {title}
      </button>
      <span className="text-[9px] text-slate-600">{weight.toFixed(2)}</span>
      <button
        type="button"
        onClick={() => onDelete(refId)}
        className="text-slate-700 hover:text-red-400 text-[10px]"
        title="Delete ref"
      >
        ×
      </button>
    </div>
  );
}
