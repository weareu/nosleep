/**
 * Shared view maths for the d3 SVG graphs (Brain graph, Strategy graph):
 *
 *  - cullLabels: collision-aware label selection. Candidates are placed in
 *    priority order (pinned first, then e.g. degree / hierarchy rank) and a
 *    label is dropped when its on-screen box would overlap one already placed
 *    or falls outside the viewport. Labels never pile on top of each other at
 *    any zoom level.
 *  - fitTransform: the zoom transform that frames a set of points in a
 *    viewport (initial fit, and re-fit when the container resizes, e.g. a
 *    side pane collapses).
 *
 * Pure functions over screen-space numbers — no d3/DOM — so both graph pages
 * share one implementation and it is unit-testable.
 */

export interface LabelCandidate {
  readonly id: string;
  /** Anchor in SCREEN pixels (node centre after the zoom transform). */
  readonly x: number;
  readonly y: number;
  /** Rendered label text (already truncated). */
  readonly text: string;
  /** Higher = placed first. */
  readonly priority: number;
  /** Pinned labels (hovered / selected) are always placed, first. */
  readonly pinned?: boolean;
  /** Screen-pixel gap between anchor and text start (node radius + pad). */
  readonly offsetX?: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

export interface CullOptions {
  /** Approximate glyph advance in px for the label font. */
  readonly charWidth?: number;
  /** Label line box height in px. */
  readonly lineHeight?: number;
  /** Extra clearance around each label box in px. */
  readonly padding?: number;
  /** Hard cap on placed labels (pinned labels always count but always fit). */
  readonly maxLabels?: number;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** Ids of the labels to show, chosen greedily by priority without overlap. */
export function cullLabels(
  candidates: readonly LabelCandidate[],
  viewport: Viewport,
  opts: CullOptions = {},
): Set<string> {
  const charWidth = opts.charWidth ?? 6;
  const lineHeight = opts.lineHeight ?? 12;
  const pad = opts.padding ?? 2;
  const maxLabels = opts.maxLabels ?? Number.POSITIVE_INFINITY;

  const ordered = [...candidates].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return b.priority - a.priority;
  });

  // Uniform grid bucket so each placement only checks nearby boxes.
  const cell = 64;
  const grid = new Map<string, Box[]>();
  const cellsFor = (b: Box): string[] => {
    const keys: string[] = [];
    for (let cx = Math.floor(b.x0 / cell); cx <= Math.floor(b.x1 / cell); cx++) {
      for (let cy = Math.floor(b.y0 / cell); cy <= Math.floor(b.y1 / cell); cy++) {
        keys.push(`${cx}:${cy}`);
      }
    }
    return keys;
  };

  const shown = new Set<string>();
  for (const c of ordered) {
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
    if (!c.pinned && shown.size >= maxLabels) break;
    const x0 = c.x + (c.offsetX ?? 0) - pad;
    const box: Box = {
      x0,
      y0: c.y - lineHeight / 2 - pad,
      x1: x0 + c.text.length * charWidth + pad * 2,
      y1: c.y + lineHeight / 2 + pad,
    };
    // The node itself must be on screen — a label whose node is off the
    // edge reads as a clipped fragment ("…nming distance").
    // Nor may the text run off the right edge (clipped "HEIC c").
    const offscreen =
      c.x < 0 || c.y < 0 || c.x > viewport.width || c.y > viewport.height || box.x1 > viewport.width;
    if (offscreen && !c.pinned) continue;
    const keys = cellsFor(box);
    if (!c.pinned) {
      const hit = keys.some((k) => grid.get(k)?.some((o) => overlaps(o, box)));
      if (hit) continue;
    }
    for (const k of keys) {
      const list = grid.get(k);
      if (list) list.push(box);
      else grid.set(k, [box]);
    }
    shown.add(c.id);
  }
  return shown;
}

export interface FitOptions {
  /** Screen-pixel margin kept around the framed points. */
  readonly padding?: number;
  readonly minScale?: number;
  readonly maxScale?: number;
}

/** Zoom transform {k, x, y} (screen = k * graph + [x, y]) framing `points`. */
export function fitTransform(
  points: ReadonlyArray<{ x?: number; y?: number }>,
  viewport: Viewport,
  opts: FitOptions = {},
): { k: number; x: number; y: number } | null {
  const padding = opts.padding ?? 40;
  const minScale = opts.minScale ?? 0.1;
  const maxScale = opts.maxScale ?? 2;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (typeof p.x !== "number" || typeof p.y !== "number") continue;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX) || viewport.width <= 0 || viewport.height <= 0) return null;
  const bw = Math.max(maxX - minX, 1);
  const bh = Math.max(maxY - minY, 1);
  const availW = Math.max(viewport.width - padding * 2, 1);
  const availH = Math.max(viewport.height - padding * 2, 1);
  const k = Math.min(maxScale, Math.max(minScale, Math.min(availW / bw, availH / bh)));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { k, x: viewport.width / 2 - cx * k, y: viewport.height / 2 - cy * k };
}
