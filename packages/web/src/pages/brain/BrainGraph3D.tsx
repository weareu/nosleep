/**
 * Phase 22-D — 3D force-graph view of the brain. Same node/edge data
 * as the d3 2D renderer; rendered via `react-force-graph-3d` (Three.js).
 *
 * Lazy-loaded from BrainGraph so the bundle cost (~600KB gz) doesn't
 * land on routes that don't need it. Click → bubbles up to the parent
 * for the existing detail panel; colour-by selector lets the user
 * pick kind / thought-type / cluster / project.
 *
 * Cluster colouring uses graphology's Louvain community detection,
 * computed once per data update.
 */

import { useEffect, useMemo, useRef } from "react";
import ForceGraph3D from "react-force-graph-3d";
import { UndirectedGraph } from "graphology";
import louvain from "graphology-communities-louvain";
import type { BrainGraphNode, BrainGraphEdge } from "../../lib/brainApi";

export type Graph3DColourMode = "kind" | "thought_type" | "cluster" | "project";

interface BrainGraph3DProps {
  readonly nodes: readonly BrainGraphNode[];
  readonly edges: readonly BrainGraphEdge[];
  readonly colourMode: Graph3DColourMode;
  readonly onSelect: (node: BrainGraphNode) => void;
  readonly selectedId?: string | null;
}

// Same colour palette spirit as the 2D view so a node looks similar
// across modes.
const KIND_COLOUR: Record<string, string> = {
  thought: "#3b82f6",
  entity: "#a855f7",
  artifact: "#64748b",
};

const THOUGHT_TYPE_COLOUR: Record<string, string> = {
  observation: "#14b8a6",
  task: "#10b981",
  idea: "#eab308",
  reference: "#a855f7",
  person_note: "#ec4899",
  decision: "#ef4444",
  insight: "#3b82f6",
  question: "#f59e0b",
};

// Per-community / per-project palette — same hashing as StrategyGraphView
// so visual identity is consistent across surfaces.
const PALETTE = [
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
  "#60a5fa",
  "#4ade80",
];

function hashColour(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

interface ForceNode {
  id: string;
  label: string;
  colour: string;
  __orig: BrainGraphNode;
  // react-force-graph mutates these
  x?: number;
  y?: number;
  z?: number;
}

interface ForceLink {
  source: string;
  target: string;
  weight: number;
}

export function BrainGraph3D({
  nodes,
  edges,
  colourMode,
  onSelect,
  selectedId,
}: BrainGraph3DProps): React.ReactElement {
  // react-force-graph-3d types its imperative handle as
  // MutableRefObject<... | undefined>; using `undefined` instead of
  // `null` keeps strict null checks happy.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(undefined);

  // Compute Louvain communities once per data set. Cheap (<50ms for
  // a few thousand nodes) but skip when colourMode isn't cluster.
  const communities = useMemo(() => {
    if (colourMode !== "cluster") return null;
    if (nodes.length === 0) return null;
    const g = new UndirectedGraph();
    for (const n of nodes) {
      if (!g.hasNode(n.id)) g.addNode(n.id);
    }
    for (const e of edges) {
      if (!g.hasNode(e.from) || !g.hasNode(e.to)) continue;
      if (g.hasEdge(e.from, e.to)) continue;
      g.addEdge(e.from, e.to, { weight: e.weight });
    }
    try {
      const partition = louvain(g, { getEdgeWeight: "weight" });
      return partition as Record<string, number>;
    } catch {
      return null;
    }
  }, [nodes, edges, colourMode]);

  const data = useMemo(() => {
    const colourFor = (n: BrainGraphNode): string => {
      switch (colourMode) {
        case "kind":
          return KIND_COLOUR[n.kind] ?? "#64748b";
        case "thought_type":
          if (n.kind === "thought") {
            return THOUGHT_TYPE_COLOUR[n.thought_type ?? "observation"] ?? "#64748b";
          }
          return KIND_COLOUR[n.kind] ?? "#64748b";
        case "cluster": {
          if (!communities) return "#64748b";
          const c = communities[n.id];
          if (c === undefined) return "#64748b";
          return PALETTE[c % PALETTE.length];
        }
        case "project":
          return n.project_id ? hashColour(n.project_id) : "#64748b";
        default:
          return "#64748b";
      }
    };

    return {
      nodes: nodes.map<ForceNode>((n) => ({
        id: n.id,
        label: n.content_snippet ?? n.label,
        colour: colourFor(n),
        __orig: n,
      })),
      links: edges
        .filter((e) => nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to))
        .map<ForceLink>((e) => ({
          source: e.from,
          target: e.to,
          weight: e.weight,
        })),
    };
  }, [nodes, edges, colourMode, communities]);

  // Re-centre when selection changes externally.
  useEffect(() => {
    if (!selectedId || !fgRef.current) return;
    const node = data.nodes.find((n) => n.id === selectedId);
    if (!node || node.x === undefined) return;
    const distance = 200;
    const distRatio = 1 + distance / Math.hypot(node.x, node.y ?? 0, node.z ?? 0);
    fgRef.current.cameraPosition(
      { x: (node.x ?? 0) * distRatio, y: (node.y ?? 0) * distRatio, z: (node.z ?? 0) * distRatio },
      { x: node.x ?? 0, y: node.y ?? 0, z: node.z ?? 0 },
      800,
    );
  }, [selectedId, data.nodes]);

  return (
    <ForceGraph3D<ForceNode, ForceLink>
      ref={fgRef}
      graphData={data}
      backgroundColor="#0b1220"
      nodeColor={(n) => (n as ForceNode).colour}
      nodeLabel={(n) => (n as ForceNode).label}
      nodeOpacity={0.95}
      nodeResolution={12}
      nodeRelSize={4}
      linkColor={() => "#475569"}
      linkOpacity={0.4}
      linkWidth={(l) => Math.max(0.3, (l as ForceLink).weight)}
      linkDirectionalParticles={0}
      onNodeClick={(n) => onSelect((n as ForceNode).__orig)}
      enableNodeDrag={false}
      controlType="orbit"
      cooldownTicks={120}
      warmupTicks={20}
    />
  );
}
