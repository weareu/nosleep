/**
 * Phase 12 (G4) — d3-force simulation in a Web Worker. Keeps the main
 * thread free for input + scroll while the force layout converges. The
 * worker receives a snapshot of nodes/links + an optional position seed
 * map (from PPR or node-degree heuristic), runs the simulation, and
 * posts back tick frames as Float32Array buffers.
 *
 * Wire:
 *   main → worker: { type: "init", nodes, links, width, height, layout, seeds? }
 *   worker → main: { type: "tick", positions: Float32Array }   // x,y interleaved per node
 *   worker → main: { type: "end" }                              // alpha decayed
 *
 * The main thread keeps a stable nodes[] array and applies position
 * frames in render order — no remount, no reflow per tick.
 */

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force";

interface WorkerNode extends SimulationNodeDatum {
  id: string;
  kind: "thought" | "entity" | "artifact";
  /** Initial position seed (PPR-derived or degree-derived). */
  seed_x?: number;
  seed_y?: number;
  degree?: number;
}

interface WorkerLink extends SimulationLinkDatum<WorkerNode> {
  source: WorkerNode | string;
  target: WorkerNode | string;
  weight: number;
}

interface InitMessage {
  type: "init";
  nodes: WorkerNode[];
  links: WorkerLink[];
  width: number;
  height: number;
  layout: "force" | "timeline";
  /** ts → x mapping for timeline mode. */
  timelineMin?: number;
  timelineMax?: number;
  /** ts per node, parallel to nodes[]. -1 if missing. */
  nodeTs?: number[];
}

let currentSim: ReturnType<typeof forceSimulation<WorkerNode>> | null = null;

function bandFor(kind: WorkerNode["kind"], height: number): number {
  if (kind === "thought") return height * 0.35;
  if (kind === "entity") return height * 0.65;
  return height * 0.85;
}

self.onmessage = (e: MessageEvent<InitMessage>) => {
  const msg = e.data;
  if (msg.type !== "init") return;

  // Cancel any running sim.
  if (currentSim) {
    currentSim.stop();
    currentSim = null;
  }

  const { nodes, links, width, height, layout } = msg;

  // Apply seeds — gives the layout a head start instead of starting at
  // origin (which causes the explosive "big bang" frame).
  for (const n of nodes) {
    if (typeof n.seed_x === "number") n.x = n.seed_x;
    if (typeof n.seed_y === "number") n.y = n.seed_y;
  }

  let sim: ReturnType<typeof forceSimulation<WorkerNode>>;
  if (layout === "timeline") {
    const tsMin = msg.timelineMin ?? 0;
    const tsMax = msg.timelineMax ?? 1;
    const tsRange = Math.max(1, tsMax - tsMin);
    const xFor = (i: number) => {
      const ts = msg.nodeTs?.[i] ?? -1;
      if (ts < 0) return width * 0.1;
      return width * (0.08 + 0.84 * ((ts - tsMin) / tsRange));
    };
    sim = forceSimulation<WorkerNode>(nodes)
      .force(
        "link",
        forceLink<WorkerNode, WorkerLink>(links)
          .id((d) => d.id)
          .distance(40)
          .strength((l) => 0.05 + l.weight * 0.1),
      )
      .force("charge", forceManyBody<WorkerNode>().strength(-30))
      .force(
        "x",
        forceX<WorkerNode>((_, i) => xFor(i)).strength(0.3),
      )
      .force(
        "y",
        forceY<WorkerNode>((d) => bandFor(d.kind, height)).strength(0.6),
      )
      .force("collide", forceCollide<WorkerNode>().radius(8))
      .alphaDecay(0.05);
  } else {
    sim = forceSimulation<WorkerNode>(nodes)
      .force(
        "link",
        forceLink<WorkerNode, WorkerLink>(links)
          .id((d) => d.id)
          .distance((l) => 60 + (1 - l.weight) * 80)
          .strength((l) => 0.3 + l.weight * 0.4),
      )
      .force("charge", forceManyBody<WorkerNode>().strength(-180))
      .force("center", forceCenter<WorkerNode>(width / 2, height / 2))
      .force("collide", forceCollide<WorkerNode>().radius(10))
      .alphaDecay(0.04);
  }

  currentSim = sim;

  const positions = new Float32Array(nodes.length * 2);
  sim.on("tick", () => {
    for (let i = 0; i < nodes.length; i++) {
      positions[i * 2] = nodes[i].x ?? 0;
      positions[i * 2 + 1] = nodes[i].y ?? 0;
    }
    // Send a copy so the main thread can read while the worker keeps
    // mutating the buffer.
    (self as unknown as { postMessage: (v: unknown) => void }).postMessage({
      type: "tick",
      positions: positions.slice(),
    });
  });

  sim.on("end", () => {
    (self as unknown as { postMessage: (v: unknown) => void }).postMessage({
      type: "end",
    });
  });
};

export {};
