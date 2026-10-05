import { describe, expect, test } from "vitest";
import { cullLabels, fitTransform, type LabelCandidate } from "./graph-view";

const VP = { width: 800, height: 600 };

function cand(id: string, x: number, y: number, priority: number, extra: Partial<LabelCandidate> = {}): LabelCandidate {
  return { id, x, y, text: "label-text", priority, ...extra };
}

describe("cullLabels", () => {
  test("drops a lower-priority label that would overlap a higher one", () => {
    const shown = cullLabels([cand("low", 100, 100, 1), cand("high", 104, 102, 9)], VP);
    expect([...shown]).toEqual(["high"]);
  });

  test("keeps labels that do not collide", () => {
    const shown = cullLabels([cand("a", 100, 100, 1), cand("b", 100, 200, 1), cand("c", 400, 100, 1)], VP);
    expect(shown).toEqual(new Set(["a", "b", "c"]));
  });

  test("pinned (hovered/selected) labels always show and win collisions", () => {
    const shown = cullLabels(
      [cand("hub", 100, 100, 100), cand("hovered", 102, 101, 0, { pinned: true })],
      VP,
    );
    expect(shown.has("hovered")).toBe(true);
    expect(shown.has("hub")).toBe(false);
  });

  test("maxLabels keeps only the highest-priority labels", () => {
    const shown = cullLabels([cand("a", 10, 10, 1), cand("b", 10, 100, 5), cand("c", 10, 200, 3)], VP, { maxLabels: 2 });
    expect(shown).toEqual(new Set(["b", "c"]));
  });

  test("a node whose anchor is off-screen gets no label even if its text would reach in", () => {
    const shown = cullLabels([cand("edge", -5, 100, 9, { offsetX: 10 })], VP);
    expect(shown.size).toBe(0);
  });

  test("skips off-screen labels and non-finite anchors", () => {
    const shown = cullLabels([cand("off", -500, 100, 5), cand("nan", Number.NaN, 0, 5), cand("on", 10, 10, 1)], VP);
    expect([...shown]).toEqual(["on"]);
  });

  test("no two placed label boxes overlap in a dense cluster", () => {
    const cands: LabelCandidate[] = [];
    for (let i = 0; i < 200; i++) cands.push(cand(`n${i}`, 300 + (i % 20) * 7, 300 + Math.floor(i / 20) * 5, i));
    const shown = cullLabels(cands, VP, { charWidth: 6, lineHeight: 12, padding: 0 });
    const boxes = cands
      .filter((c) => shown.has(c.id))
      .map((c) => ({ x0: c.x, x1: c.x + c.text.length * 6, y0: c.y - 6, y1: c.y + 6 }));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlap = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
        expect(overlap).toBe(false);
      }
    }
    // Highest priority node of the cluster is among those shown.
    expect(shown.has("n199")).toBe(true);
  });
});

describe("fitTransform", () => {
  test("centres the bounding box in the viewport", () => {
    const t = fitTransform([{ x: 0, y: 0 }, { x: 100, y: 50 }], VP, { padding: 0, maxScale: 100 })!;
    // centre (50,25) maps to viewport centre
    expect(t.k * 50 + t.x).toBeCloseTo(400);
    expect(t.k * 25 + t.y).toBeCloseTo(300);
    expect(t.k).toBeCloseTo(8); // limited by width: 800/100
  });

  test("re-fit after the container grows re-centres on the new size", () => {
    const pts = [{ x: 10, y: 10 }, { x: 30, y: 30 }];
    const narrow = fitTransform(pts, { width: 500, height: 600 })!;
    const wide = fitTransform(pts, { width: 800, height: 600 })!;
    expect(narrow.k * 20 + narrow.x).toBeCloseTo(250);
    expect(wide.k * 20 + wide.x).toBeCloseTo(400);
  });

  test("returns null with no positioned points", () => {
    expect(fitTransform([{}], VP)).toBeNull();
  });
});
