import { useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";
import {
  zoom as d3zoom,
  zoomIdentity,
  type ZoomBehavior,
  type ZoomTransform,
} from "d3-zoom";
import { drag as d3drag } from "d3-drag";
import { select } from "d3-selection";
import { Link, useSearchParams } from "react-router-dom";
import { humanizeApiError } from "../../lib/humanize-error";
import {
  brainGetGraph,
  brainRecomputeGraph,
  type BrainGraphNode,
  type BrainGraphEdge,
  type BrainGraphResponse,
} from "../../lib/brainApi";
import { useOrgProject } from "../../components/OrgProjectPicker";
import { cullLabels, fitTransform } from "../../lib/graph-view";
import { BrainNodeDetail } from "./BrainNodeDetail";
// Phase 22-D — lazy-load the 3D renderer. ~600KB gz of Three.js + lib
// shouldn't land on routes that don't actually open the 3D mode.
const BrainGraph3D = lazy(() => import("./BrainGraph3D").then((m) => ({ default: m.BrainGraph3D })));

interface SimNode extends BrainGraphNode, SimulationNodeDatum {
  fx?: number | null;
  fy?: number | null;
  /** Pre-computed degree (link count) for LOD ranking. */
  degree?: number;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  source: SimNode | string;
  target: SimNode | string;
  relation: string;
  weight: number;
  source_kind: BrainGraphEdge["source"];
}

const TYPE_COLOURS: Record<string, string> = {
  decision: "#ef4444",
  insight: "#3b82f6",
  task: "#10b981",
  question: "#f59e0b",
  observation: "#14b8a6",
  reference: "#a855f7",
  person_note: "#ec4899",
  idea: "#eab308",
  // entities
  topic: "#0ea5e9",
  person: "#f472b6",
  concept: "#84cc16",
  external_project: "#fb923c",
  tool: "#94a3b8",
  agent: "#a3e635",
  place: "#fbbf24",
  // archive default
  artifact: "#475569",
};

// Phase 22-D — colour selector also applies in 2D. Cluster mode falls
// back to kind in 2D since the heavyweight Louvain calc only runs in
// the 3D component.
const PROJECT_PALETTE = [
  "#a78bfa", "#34d399", "#fb923c", "#f472b6", "#facc15",
  "#22d3ee", "#f87171", "#a3e635", "#fbbf24", "#c084fc",
  "#60a5fa", "#4ade80",
];
function hashProjectColour(projectId: string): string {
  let h = 0;
  for (let i = 0; i < projectId.length; i++) h = (h * 31 + projectId.charCodeAt(i)) | 0;
  return PROJECT_PALETTE[Math.abs(h) % PROJECT_PALETTE.length];
}

function colourFor(node: BrainGraphNode, mode: ColourMode = "kind"): string {
  if (mode === "project" && node.project_id) {
    return hashProjectColour(node.project_id);
  }
  // thought_type / cluster (2D fallback) / kind all share the same
  // path below — explicit thought_type colouring when available,
  // entity_kind as a secondary signal, artifact as fallback.
  if (node.kind === "thought") {
    return TYPE_COLOURS[node.thought_type ?? "observation"] ?? "#64748b";
  }
  if (node.kind === "entity") {
    return TYPE_COLOURS[node.entity_kind ?? "topic"] ?? "#64748b";
  }
  return TYPE_COLOURS.artifact;
}

function radiusFor(node: BrainGraphNode): number {
  if (node.kind === "entity") return 7;
  if (node.kind === "artifact") return 4;
  return 6;
}

/** Vertical band per kind for timeline layout (relative position 0..1). */
function bandFor(kind: BrainGraphNode["kind"]): number {
  if (kind === "thought") return 0.35;
  if (kind === "entity") return 0.65;
  return 0.85; // artifact at the bottom
}

type LayoutMode = "force" | "timeline" | "force-3d";
type ColourMode = "kind" | "thought_type" | "cluster" | "project";

/**
 * LOD thresholds. Below LOD_HIDE_LABELS, draw circles only; below
 * LOD_HIDE_LIGHT_EDGES, hide edges with weight under the cutoff. Above
 * LOD_SHOW_LABELS, always-on text labels appear.
 */
const LOD_HIDE_LIGHT_EDGES = 0.4;
const LOD_LIGHT_EDGE_WEIGHT_CUTOFF = 0.4;
const LOD_SHOW_LABELS = 1.4;
/** Labels shown below LOD_SHOW_LABELS — the highest-degree hubs only. */
const LOD_HUB_LABELS = 8;
/** On-screen label font size (px) — counter-scaled so zoom never inflates it. */
const LABEL_FONT_PX = 10;

function labelText(node: BrainGraphNode): string {
  return node.label.length > 32 ? node.label.slice(0, 30) + "…" : node.label;
}

export function BrainGraph(): React.ReactElement {
  const { scope } = useOrgProject();
  const { orgId, projectId } = scope;
  const [layers, setLayers] = useState<{
    thoughts: boolean;
    entities: boolean;
    archive: boolean;
  }>({ thoughts: true, entities: true, archive: false });
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("force");
  // Phase 22-D — colour-by selector. Default `kind` matches existing
  // d3 colouring. `cluster` uses Louvain communities computed by the
  // 3D component.
  const [colourMode, setColourMode] = useState<ColourMode>("kind");
  const [data, setData] = useState<BrainGraphResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<BrainGraphNode | null>(null);
  const [recomputing, setRecomputing] = useState(false);
  const [zoomScale, setZoomScale] = useState(1);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const transformRef = useRef<ZoomTransform>(zoomIdentity);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  // Label culling inputs read from d3 callbacks (zoom / tick) without
  // re-running the simulation effect.
  const pinnedLabelIdsRef = useRef<Set<string>>(new Set());
  const userMovedViewRef = useRef(false);

  // Phase 12 (UI review #2 — H/M) — incoming focus from the artifact,
  // thought, or session toolbars. The hash for artifacts and the id for
  // thoughts both correspond directly to a graph node id, so a single
  // resolved value is enough — but we read both names so the toolbar
  // links don't have to know the implementation detail.
  const [params] = useSearchParams();
  const focusId = params.get("focus") ?? params.get("thought") ?? null;
  const [focusMissing, setFocusMissing] = useState<string | null>(null);

  // Phase 22-A — filter pane state.
  const [filterPaneOpen, setFilterPaneOpen] = useState(true);
  const [searchText, setSearchText] = useState("");
  const [hideOrphans, setHideOrphans] = useState(false);
  const [edgeWeightMin, setEdgeWeightMin] = useState(0);
  const [selectedKinds, setSelectedKinds] = useState<
    Set<"thought" | "entity" | "artifact">
  >(new Set(["thought", "entity", "artifact"]));
  // Local-graph isolation (Phase 22-A — "Isolate" button on detail panel)
  const [isolateNodeId, setIsolateNodeId] = useState<string | null>(null);
  const [isolateDepth, setIsolateDepth] = useState(2);
  // Hover preview state for tooltip
  const [hovered, setHovered] = useState<BrainGraphNode | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  // Phase 22-E — time-decay tau. 0 = no decay; the slider exposes
  // 7/30/90/180/none as discrete steps mapped to tau days.
  const [decayTauDays, setDecayTauDays] = useState(0);
  // Phase 22-E — K-core compact view. Hides nodes outside the k-core
  // (k=2 by default) — i.e. orbital singletons. Cheap client-side
  // implementation since the visible set is bounded by `limit`.
  const [kCoreMin, setKCoreMin] = useState(0);

  async function load() {
    if (!projectId) return;
    setLoading(true);
    setErr(null);
    try {
      const layerStr = (
        Object.entries(layers).filter(([, v]) => v).map(([k]) => k) as Array<
          "thoughts" | "entities" | "archive"
        >
      ).join(",");
      const r = await brainGetGraph({
        org_id: orgId,
        project_id: projectId,
        layers: layerStr,
        limit: 1000,
        decay_tau_days: decayTauDays > 0 ? decayTauDays : undefined,
      });
      setData(r);
    } catch (e) {
      setErr(humanizeApiError(e));
    } finally {
      setLoading(false);
    }
  }

  async function recompute() {
    if (!projectId) return;
    setRecomputing(true);
    try {
      await brainRecomputeGraph({ org_id: orgId, project_id: projectId });
      await load();
    } catch (e) {
      setErr(humanizeApiError(e));
    } finally {
      setRecomputing(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, projectId, layers, decayTauDays]);

  // Phase 22-A — apply filters before feeding the sim. Memoised so
  // toggles don't trigger a re-fetch. When isolateNodeId is set, we BFS
  // out N hops from that node and only show that neighbourhood.
  const filteredData = useMemo((): BrainGraphResponse | null => {
    if (!data) return null;

    // Pre-build adjacency for orphan check + isolation.
    const adj = new Map<string, Set<string>>();
    for (const e of data.edges) {
      if (!adj.has(e.from)) adj.set(e.from, new Set());
      if (!adj.has(e.to)) adj.set(e.to, new Set());
      adj.get(e.from)!.add(e.to);
      adj.get(e.to)!.add(e.from);
    }

    // Compute isolated neighbourhood ids (BFS up to depth) if active.
    let visibleIds: Set<string> | null = null;
    if (isolateNodeId && adj.has(isolateNodeId)) {
      visibleIds = new Set([isolateNodeId]);
      let frontier = new Set([isolateNodeId]);
      for (let d = 0; d < isolateDepth; d++) {
        const next = new Set<string>();
        for (const id of frontier) {
          for (const nb of adj.get(id) ?? []) {
            if (!visibleIds!.has(nb)) {
              visibleIds!.add(nb);
              next.add(nb);
            }
          }
        }
        if (next.size === 0) break;
        frontier = next;
      }
    }

    const q = searchText.trim().toLowerCase();

    const nodes = data.nodes.filter((n) => {
      if (visibleIds && !visibleIds.has(n.id)) return false;
      if (!selectedKinds.has(n.kind)) return false;
      if (hideOrphans && (n.degree ?? 0) === 0) return false;
      if (q) {
        const hay = `${n.label} ${n.content_snippet ?? ""} ${(n.topics ?? []).join(" ")} ${(n.people ?? []).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const visibleNodeIds = new Set(nodes.map((n) => n.id));
    let edges = data.edges.filter((e) => {
      // Phase 22-E — use effective_weight for the slider so the decayed
      // strength is what's filtered. Falls back to weight when server
      // didn't compute it (older response shape).
      const w = e.effective_weight ?? e.weight;
      if (w < edgeWeightMin) return false;
      return visibleNodeIds.has(e.from) && visibleNodeIds.has(e.to);
    });

    // Phase 22-E — K-core compact view. Iteratively peel nodes with
    // visible degree < kCoreMin until the graph stabilises. The "core"
    // is the dense backbone of the graph minus orbital singletons.
    let coreNodes = nodes;
    if (kCoreMin >= 2) {
      const adj = new Map<string, Set<string>>();
      for (const e of edges) {
        if (!adj.has(e.from)) adj.set(e.from, new Set());
        if (!adj.has(e.to)) adj.set(e.to, new Set());
        adj.get(e.from)!.add(e.to);
        adj.get(e.to)!.add(e.from);
      }
      const inCore = new Set(nodes.map((n) => n.id));
      let changed = true;
      while (changed) {
        changed = false;
        for (const id of [...inCore]) {
          const deg = [...(adj.get(id) ?? new Set())].filter((nb) => inCore.has(nb)).length;
          if (deg < kCoreMin) {
            inCore.delete(id);
            changed = true;
          }
        }
      }
      coreNodes = nodes.filter((n) => inCore.has(n.id));
      const coreIds = new Set(coreNodes.map((n) => n.id));
      edges = edges.filter((e) => coreIds.has(e.from) && coreIds.has(e.to));
    }

    return {
      ...data,
      nodes: coreNodes,
      edges,
      density: {
        ...data.density,
        node_count: coreNodes.length,
        edge_count: edges.length,
      },
    };
  }, [
    data,
    isolateNodeId,
    isolateDepth,
    selectedKinds,
    hideOrphans,
    searchText,
    edgeWeightMin,
    kCoreMin,
  ]);

  // Set up D3 simulation whenever data or layout changes.
  useEffect(() => {
    if (!svgRef.current || !filteredData) return;
    const width = svgRef.current.clientWidth || 900;
    const height = svgRef.current.clientHeight || 600;

    const nodes: SimNode[] = filteredData.nodes.map((n) => ({ ...n, degree: 0 }));

    // Pre-compute degree for LOD pruning later (which nodes are "important").
    const degById = new Map<string, number>();
    for (const e of filteredData.edges) {
      degById.set(e.from, (degById.get(e.from) ?? 0) + 1);
      degById.set(e.to, (degById.get(e.to) ?? 0) + 1);
    }
    for (const n of nodes) n.degree = degById.get(n.id) ?? 0;

    const links: SimLink[] = filteredData.edges
      .filter(
        (e) =>
          nodes.some((n) => n.id === e.from) &&
          nodes.some((n) => n.id === e.to),
      )
      .map((e) => ({
        source: e.from,
        target: e.to,
        relation: e.relation,
        // Phase 22-E — sim + stroke use effective_weight so the decay
        // shows up visually (thinner old edges, fatter recent ones).
        weight: e.effective_weight ?? e.weight,
        source_kind: e.source,
      }));

    if (simRef.current) simRef.current.stop();

    // Layout-specific forces.
    let sim: Simulation<SimNode, SimLink>;
    if (layoutMode === "timeline") {
      // Map node.ts to a horizontal position. Nodes without ts pile at the
      // left margin (1/8 width).
      const tsValues = nodes
        .map((n) => n.ts)
        .filter((t): t is number => typeof t === "number");
      const tsMin = tsValues.length > 0 ? Math.min(...tsValues) : 0;
      const tsMax = tsValues.length > 0 ? Math.max(...tsValues) : 1;
      const tsRange = Math.max(1, tsMax - tsMin);
      const xFor = (n: SimNode) => {
        if (typeof n.ts !== "number") return width * 0.1;
        return width * (0.08 + 0.84 * ((n.ts - tsMin) / tsRange));
      };
      const yFor = (n: SimNode) => height * bandFor(n.kind);

      sim = forceSimulation<SimNode>(nodes)
        .force(
          "link",
          forceLink<SimNode, SimLink>(links)
            .id((d) => d.id)
            .distance(40)
            .strength((l) => 0.05 + l.weight * 0.1),
        )
        .force("charge", forceManyBody<SimNode>().strength(-30))
        .force("x", forceX<SimNode>(xFor).strength(0.3))
        .force("y", forceY<SimNode>(yFor).strength(0.6))
        .force(
          "collide",
          forceCollide<SimNode>().radius((d) => radiusFor(d) + 2),
        )
        .alphaDecay(0.05);
    } else {
      sim = forceSimulation<SimNode>(nodes)
        .force(
          "link",
          forceLink<SimNode, SimLink>(links)
            .id((d) => d.id)
            .distance((l) => 60 + (1 - l.weight) * 80)
            .strength((l) => 0.3 + l.weight * 0.4),
        )
        .force("charge", forceManyBody<SimNode>().strength(-180))
        .force("center", forceCenter<SimNode>(width / 2, height / 2))
        .force(
          "collide",
          forceCollide<SimNode>().radius((d) => radiusFor(d) + 4),
        )
        .alphaDecay(0.04);
    }

    simRef.current = sim;
    nodesRef.current = nodes;

    const svg = select(svgRef.current);
    svg.selectAll("*").remove();

    const g = svg.append("g");

    const zoomBehaviour = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 6])
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

    // Timeline axis (only in timeline mode)
    if (layoutMode === "timeline") {
      const tsValues = nodes
        .map((n) => n.ts)
        .filter((t): t is number => typeof t === "number");
      if (tsValues.length > 1) {
        const tsMin = Math.min(...tsValues);
        const tsMax = Math.max(...tsValues);
        const axisG = g
          .append("g")
          .attr("class", "timeline-axis")
          .attr("transform", `translate(0, ${height - 18})`);
        // 5 evenly spaced tick marks
        for (let i = 0; i <= 4; i++) {
          const t = tsMin + ((tsMax - tsMin) * i) / 4;
          const x = width * (0.08 + 0.84 * (i / 4));
          axisG
            .append("line")
            .attr("x1", x)
            .attr("y1", -height + 30)
            .attr("x2", x)
            .attr("y2", 0)
            .attr("stroke", "#1e293b")
            .attr("stroke-dasharray", "2,4");
          axisG
            .append("text")
            .attr("x", x)
            .attr("y", 14)
            .attr("text-anchor", "middle")
            .attr("font-size", 10)
            .attr("fill", "#64748b")
            .text(new Date(t * 1000).toISOString().slice(0, 10));
        }
      }
    }

    const linkSel = g
      .append("g")
      .attr("class", "links")
      .attr("stroke-opacity", 0.4)
      .selectAll("line")
      .data(links)
      .enter()
      .append("line")
      .attr("stroke", (d) => {
        if (d.source_kind === "thought_refs") return "#94a3b8";
        if (d.source_kind === "entity_refs") return "#475569";
        return "#334155";
      })
      .attr("stroke-width", (d) => 0.5 + d.weight * 1.5);

    const nodeSel = g
      .append("g")
      .attr("class", "nodes")
      .attr("stroke", "#0f172a")
      .attr("stroke-width", 1.5)
      .selectAll("circle")
      .data(nodes)
      .enter()
      .append("circle")
      .attr("r", (d) => radiusFor(d))
      .attr("fill", (d) => colourFor(d, colourMode))
      .style("cursor", "pointer")
      .on("click", (_e, d) => setSelected(d as BrainGraphNode))
      .on("mouseenter", (e: MouseEvent, d) => {
        setHovered(d as BrainGraphNode);
        setHoverPos({ x: e.clientX, y: e.clientY });
      })
      .on("mouseleave", () => setHovered(null));

    nodeSel.append("title").text((d) => d.label);

    // Label layer. Which labels show is decided by refreshLabels():
    // collision-culled by degree (hubs first) above the LOD zoom, and the
    // hovered/selected node always. Each text is hidden until placed.
    const labelSel = g
      .append("g")
      .attr("class", "labels")
      .attr("pointer-events", "none")
      .selectAll("text")
      .data(nodes)
      .enter()
      .append("text")
      .attr("fill", "#cbd5e1")
      .attr("paint-order", "stroke")
      .attr("stroke", "#0b1220")
      .attr("stroke-width", 3)
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
        // In timeline mode, keep nodes pinned to their time-x so the user
        // doesn't have to fight the layout.
        if (layoutMode === "timeline") {
          d.fy = null;
        } else {
          d.fx = null;
          d.fy = null;
        }
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
      if (++tickCount % 8 === 0) refreshLabels();
    });
    // Frame the settled layout once, unless the user already panned/zoomed
    // or a focus target is about to take over the view.
    sim.on("end", () => {
      if (!userMovedViewRef.current && !focusId) fitView();
      refreshLabels();
    });
    refreshLabels();

    return () => {
      sim.stop();
    };
    // refreshLabels/fitView read refs only; focusId gates the auto-fit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredData, layoutMode, colourMode]);

  /** Show the labels that fit, in priority order (see lib/graph-view). */
  function refreshLabels(): void {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const t = transformRef.current;
    const k = t.k;
    const zoomedIn = k >= LOD_SHOW_LABELS;
    const pinned = pinnedLabelIdsRef.current;
    const candidates = nodesRef.current
      // Zoomed out: only connected hubs compete for the few label slots.
      .filter((n) => zoomedIn || pinned.has(n.id) || (n.degree ?? 0) > 0)
      .map((n) => ({
        id: n.id,
        x: t.applyX(n.x ?? 0),
        y: t.applyY(n.y ?? 0),
        text: labelText(n),
        priority: n.degree ?? 0,
        pinned: pinned.has(n.id),
        offsetX: radiusFor(n) * k + 3,
      }));
    const shown = cullLabels(
      candidates,
      { width: svgEl.clientWidth || 900, height: svgEl.clientHeight || 600 },
      {
        charWidth: LABEL_FONT_PX * 0.6,
        lineHeight: LABEL_FONT_PX + 2,
        // Zoomed out: label just the top hubs (by degree) for orientation;
        // zoomed in: every label that fits without overlapping.
        maxLabels: zoomedIn ? undefined : LOD_HUB_LABELS,
      },
    );
    select(svgEl)
      .select("g.labels")
      .selectAll<SVGTextElement, SimNode>("text")
      .attr("font-size", LABEL_FONT_PX / k)
      .attr("stroke-width", 3 / k)
      .attr("dx", (d) => radiusFor(d) + 3 / k)
      .attr("dy", (LABEL_FONT_PX * 0.35) / k)
      .style("display", (d) => (shown.has(d.id) ? null : "none"));
  }

  /** Zoom so every node is in view, centred in the current SVG size. */
  function fitView(): void {
    const svgEl = svgRef.current;
    const zoomBehaviour = zoomRef.current;
    if (!svgEl || !zoomBehaviour) return;
    const fit = fitTransform(nodesRef.current, {
      width: svgEl.clientWidth,
      height: svgEl.clientHeight,
    }, { maxScale: 1.6 });
    if (!fit) return;
    select(svgEl).call(
      zoomBehaviour.transform as never,
      zoomIdentity.translate(fit.x, fit.y).scale(fit.k),
    );
  }

  // Hovered / selected labels are always shown (pinned) regardless of zoom.
  useEffect(() => {
    const ids = new Set<string>();
    if (hovered) ids.add(hovered.id);
    if (selected) ids.add(selected.id);
    pinnedLabelIdsRef.current = ids;
    refreshLabels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hovered, selected]);

  // Re-fit when the canvas resizes (filter pane collapse/expand, detail
  // panel, window resize) so the graph re-centres in the new space.
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
  }, [layoutMode]);

  // Apply LOD on zoom changes — toggle classes / opacity instead of rebuilding
  // the SVG structure each tick.
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = select(svgRef.current);

    // Drop low-weight edges when zoomed out so the graph reads as
    // structure rather than noise.
    if (zoomScale < LOD_HIDE_LIGHT_EDGES) {
      svg
        .select("g.links")
        .selectAll<SVGLineElement, SimLink>("line")
        .style("display", (d) =>
          d.weight < LOD_LIGHT_EDGE_WEIGHT_CUTOFF ? "none" : "block",
        );
    } else {
      svg
        .select("g.links")
        .selectAll<SVGLineElement, SimLink>("line")
        .style("display", "block");
    }

    // Keep stroke crisp at all zooms (counter-scale).
    svg
      .select("g.links")
      .selectAll<SVGLineElement, SimLink>("line")
      .attr("stroke-width", (d) =>
        Math.max(0.4, (0.5 + d.weight * 1.5) / zoomScale),
      );
  }, [zoomScale, data, layoutMode]);

  // Pan/zoom to a focused node when the URL carries one. Waits for the
  // simulation to relax so we don't race the layout to (0, 0). If the
  // node isn't in the current graph (e.g. archive layer is off) we
  // surface a banner so the user can flip the layer toggle.
  useEffect(() => {
    if (!focusId || !data || !svgRef.current) return;
    setFocusMissing(null);

    const node = nodesRef.current.find((n) => n.id === focusId);
    if (!node) {
      setFocusMissing(focusId);
      return;
    }

    setSelected(node);

    // Give the sim a few hundred ms to settle, then pan + scale.
    const handle = window.setTimeout(() => {
      const svg = svgRef.current;
      const zoomBehaviour = zoomRef.current;
      if (!svg || !zoomBehaviour) return;
      const w = svg.clientWidth || 900;
      const h = svg.clientHeight || 600;
      const nx = node.x ?? w / 2;
      const ny = node.y ?? h / 2;
      const targetScale = 1.6;
      const tx = w / 2 - nx * targetScale;
      const ty = h / 2 - ny * targetScale;
      const target = zoomIdentity.translate(tx, ty).scale(targetScale);
      // No d3-transition dep — snap rather than animate. Still feels
      // instant since we already waited for sim relax.
      select(svg).call(zoomBehaviour.transform as never, target);
    }, 350);

    return () => window.clearTimeout(handle);
  }, [focusId, data, layoutMode]);

  const densityWarning = useMemo(() => {
    if (!data) return null;
    if (data.density.warning === "hard") {
      return `${data.density.node_count} nodes — beyond visible threshold (${data.density.hard_limit}). Switch to a list view.`;
    }
    if (data.density.warning === "soft") {
      return `${data.density.node_count} nodes — getting dense. Consider narrowing project scope.`;
    }
    return null;
  }, [data]);

  return (
    <div className="flex flex-col h-full text-slate-200">
      <div className="p-4 border-b border-slate-800 flex flex-wrap items-end gap-3 bg-slate-900">
        <Field label="Layout">
          <div className="flex rounded border border-slate-700 overflow-hidden">
            {(["force", "force-3d", "timeline"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setLayoutMode(m)}
                className={`px-3 py-2 text-xs ${
                  layoutMode === m
                    ? "bg-blue-600 text-white"
                    : "bg-slate-900 text-slate-400 hover:text-slate-200"
                }`}
              >
                {m === "force-3d" ? "3D" : m}
              </button>
            ))}
          </div>
        </Field>
        {/* Phase 22-D — colour selector */}
        <Field label="Colour">
          <select
            value={colourMode}
            onChange={(e) => setColourMode(e.target.value as ColourMode)}
            className="bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200"
          >
            <option value="kind">kind</option>
            <option value="thought_type">thought type</option>
            <option value="cluster">cluster (Louvain)</option>
            <option value="project">project</option>
          </select>
        </Field>
        <div className="flex gap-3 items-center text-xs">
          {(["thoughts", "entities", "archive"] as const).map((l) => (
            <label key={l} className="flex items-center gap-1 text-slate-300">
              <input
                type="checkbox"
                checked={layers[l]}
                onChange={(e) =>
                  setLayers((p) => ({ ...p, [l]: e.target.checked }))
                }
              />
              {l}
            </label>
          ))}
        </div>
        <button
          type="button"
          onClick={recompute}
          disabled={!projectId || recomputing}
          className="px-3 py-2 text-sm rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 border border-slate-700"
        >
          {recomputing ? "Recomputing…" : "Recompute edges"}
        </button>
        {data && (
          <span className="text-xs text-slate-500 ml-auto">
            {filteredData?.density.node_count ?? data.density.node_count} / {data.density.node_count} nodes ·
            {" "}{filteredData?.density.edge_count ?? data.density.edge_count} / {data.density.edge_count} edges ·
            zoom {zoomScale.toFixed(2)}×
          </span>
        )}
      </div>

      {err && (
        <div className="m-3 text-red-400 bg-red-950/30 border border-red-900 p-3 rounded">
          {err}
        </div>
      )}
      {densityWarning && (
        <div className="m-3 text-amber-300 bg-amber-950/30 border border-amber-900 p-2 rounded text-xs">
          {densityWarning}
        </div>
      )}
      {focusMissing && (
        <div className="m-3 text-blue-300 bg-blue-950/30 border border-blue-900 p-2 rounded text-xs">
          Couldn't find <span className="font-mono">{focusMissing.slice(0, 16)}…</span>{" "}
          in the current view. Try toggling the{" "}
          <span className="font-medium">archive</span> layer (artifacts are
          hidden by default), or widen the project scope.
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* Phase 22-A — collapsible filter pane (left) */}
        {filterPaneOpen ? (
          <aside className="w-72 flex-shrink-0 border-r border-slate-800 bg-slate-900 overflow-y-auto p-3 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
                Filters
              </span>
              <button
                type="button"
                onClick={() => setFilterPaneOpen(false)}
                className="text-slate-500 hover:text-slate-200 text-xs"
                aria-label="Collapse filter pane"
              >
                ◀
              </button>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-1">
                Search
              </label>
              <input
                type="search"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="title / snippet / topics"
                className="w-full bg-slate-950 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-1">
                Kinds
              </label>
              <div className="flex flex-wrap gap-1">
                {(["thought", "entity", "artifact"] as const).map((k) => {
                  const active = selectedKinds.has(k);
                  return (
                    <button
                      key={k}
                      type="button"
                      onClick={() => {
                        const next = new Set(selectedKinds);
                        if (active) next.delete(k);
                        else next.add(k);
                        setSelectedKinds(next);
                      }}
                      className={`text-[10px] px-2 py-0.5 rounded ${
                        active
                          ? "bg-blue-900/50 text-blue-200 border border-blue-700"
                          : "bg-slate-800 text-slate-500 border border-slate-700"
                      }`}
                    >
                      {k}
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={hideOrphans}
                onChange={(e) => setHideOrphans(e.target.checked)}
              />
              Hide orphan nodes (degree 0)
            </label>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-1">
                Min edge weight: {edgeWeightMin.toFixed(2)}
              </label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={edgeWeightMin}
                onChange={(e) => setEdgeWeightMin(parseFloat(e.target.value))}
                className="w-full"
              />
            </div>
            {/* Phase 22-E — time decay. Discrete steps so the slider's
                meaning stays intuitive: 0=off, 7d=recent-only, 30d=this
                month, 90d=this quarter, 180d=long horizon. */}
            <div>
              <label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-1">
                Decay tau: {decayTauDays === 0 ? "off" : `${decayTauDays}d`}
              </label>
              <div className="flex gap-1">
                {[0, 7, 30, 90, 180].map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setDecayTauDays(t)}
                    className={`flex-1 text-[10px] py-0.5 rounded ${
                      decayTauDays === t
                        ? "bg-blue-900/50 text-blue-200 border border-blue-700"
                        : "bg-slate-800 text-slate-500 border border-slate-700"
                    }`}
                  >
                    {t === 0 ? "off" : `${t}d`}
                  </button>
                ))}
              </div>
            </div>
            {/* Phase 22-E — K-core compact view. k=2 is the "no orphans
                with single connection" view; k=3 collapses to the dense
                triangulated core. */}
            <div>
              <label className="text-[10px] uppercase tracking-wider text-slate-500 block mb-1">
                K-core: {kCoreMin === 0 ? "off" : `k≥${kCoreMin}`}
              </label>
              <div className="flex gap-1">
                {[0, 2, 3].map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKCoreMin(k)}
                    className={`flex-1 text-[10px] py-0.5 rounded ${
                      kCoreMin === k
                        ? "bg-blue-900/50 text-blue-200 border border-blue-700"
                        : "bg-slate-800 text-slate-500 border border-slate-700"
                    }`}
                  >
                    {k === 0 ? "off" : `k≥${k}`}
                  </button>
                ))}
              </div>
            </div>
            {isolateNodeId && (
              <div className="bg-blue-950/30 border border-blue-900 rounded p-2 space-y-2">
                <div className="text-[10px] uppercase tracking-wider text-blue-300">
                  Local mode active
                </div>
                <div className="text-[10px] text-slate-400 font-mono break-all">
                  {isolateNodeId.slice(0, 16)}…
                </div>
                <div>
                  <label className="text-[10px] text-slate-400 block mb-0.5">
                    Hops: {isolateDepth}
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={4}
                    step={1}
                    value={isolateDepth}
                    onChange={(e) => setIsolateDepth(parseInt(e.target.value, 10))}
                    className="w-full"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setIsolateNodeId(null)}
                  className="w-full text-[10px] uppercase tracking-wider text-slate-300 bg-slate-800 hover:bg-slate-700 rounded py-1"
                >
                  Clear local mode
                </button>
              </div>
            )}
            {filteredData && (
              <div className="text-[10px] text-slate-600 pt-2 border-t border-slate-800">
                Showing {filteredData.density.node_count} / {data?.density.node_count ?? 0} nodes
                <br />
                {filteredData.density.edge_count} / {data?.density.edge_count ?? 0} edges
              </div>
            )}
          </aside>
        ) : (
          <button
            type="button"
            onClick={() => setFilterPaneOpen(true)}
            className="w-6 flex-shrink-0 border-r border-slate-800 bg-slate-900 text-slate-500 hover:text-slate-200 hover:bg-slate-800 text-xs"
            aria-label="Expand filter pane"
          >
            ▶
          </button>
        )}

        <div className="flex-1 relative overflow-hidden">
          {/* Phase 22-D — 3D mode swaps the SVG for the Three.js renderer. */}
          {layoutMode === "force-3d" && filteredData ? (
            <Suspense
              fallback={
                <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-sm">
                  loading 3D renderer…
                </div>
              }
            >
              <BrainGraph3D
                nodes={filteredData.nodes}
                edges={filteredData.edges}
                colourMode={colourMode}
                selectedId={selected?.id ?? null}
                onSelect={(n) => setSelected(n)}
              />
            </Suspense>
          ) : (
            <svg
              ref={svgRef}
              className="w-full h-full"
              style={{ background: "#0b1220" }}
            />
          )}
          {loading && (
            <div className="absolute top-3 left-3 text-xs text-slate-400 bg-slate-900/80 px-2 py-1 rounded">
              loading…
            </div>
          )}
          {zoomScale < LOD_HIDE_LIGHT_EDGES && layoutMode !== "force-3d" && (
            <div className="absolute bottom-3 left-3 text-[10px] text-slate-500 bg-slate-900/70 px-2 py-1 rounded border border-slate-800">
              LOD: light edges hidden — zoom in for detail
            </div>
          )}
          {/* Phase 22-A — hover preview tooltip */}
          {hovered && hoverPos && (
            <div
              className="absolute pointer-events-none bg-slate-900/95 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-200 max-w-xs shadow-lg"
              style={{
                left: Math.min(hoverPos.x + 12, window.innerWidth - 320),
                top: Math.min(hoverPos.y + 12, window.innerHeight - 80),
              }}
            >
              <div className="text-[9px] uppercase tracking-wider text-slate-500 mb-0.5">
                {hovered.kind}
                {hovered.thought_type ? ` · ${hovered.thought_type}` : ""}
                {hovered.project_name ? ` · ${hovered.project_name}` : ""}
              </div>
              <div className="truncate">{hovered.label}</div>
              {hovered.ts && (
                <div className="text-[9px] text-slate-600 mt-0.5">
                  {new Date(hovered.ts * 1000).toLocaleString()}
                </div>
              )}
            </div>
          )}
          {!projectId && !loading && (
            <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-sm">
              specify a project to render the graph
            </div>
          )}
        </div>

        {/* Phase 22-A — proper right-side detail panel */}
        {selected && filteredData && (
          <aside className="w-96 flex-shrink-0 border-l border-slate-800 overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
              <span className="text-[10px] uppercase tracking-widest text-slate-500">
                Detail
              </span>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="text-slate-500 hover:text-slate-200 text-sm"
                aria-label="Close detail panel"
              >
                ×
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              <BrainNodeDetail
                node={selected}
                edges={filteredData.edges}
                allNodes={filteredData.nodes}
                orgId={orgId}
                onNavigateNode={(id) => {
                  const next = (data?.nodes ?? []).find((n) => n.id === id);
                  if (next) setSelected(next);
                }}
                onIsolate={(id) => setIsolateNodeId(id)}
              />
            </div>
          </aside>
        )}
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
