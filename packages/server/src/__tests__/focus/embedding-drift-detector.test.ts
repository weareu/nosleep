import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  EmbeddingDriftDetector,
  cosineSimilarity,
  DEFAULT_EMBEDDING_DRIFT_CONFIG,
} from "../../focus/embedding-drift-detector.js";

/**
 * Build an L2-normalized vector pointing in a specific 3-D direction,
 * padded out to `dim` zeros for the rest. Two vectors with the same
 * direction have cosine similarity 1; orthogonal vectors have 0;
 * opposite vectors have -1.
 */
function unitVector(direction: [number, number, number], dim = 16): Float32Array {
  const v = new Float32Array(dim);
  v[0] = direction[0];
  v[1] = direction[1];
  v[2] = direction[2];
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) v[i] /= norm;
  }
  return v;
}

describe("cosineSimilarity", () => {
  it("returns 1 for identical normalized vectors", () => {
    const a = unitVector([1, 0, 0]);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 6);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = unitVector([1, 0, 0]);
    const b = unitVector([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 6);
  });

  it("returns -1 for opposing vectors", () => {
    const a = unitVector([1, 0, 0]);
    const b = unitVector([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 6);
  });

  it("clamps numerical drift to [-1, 1]", () => {
    // Construct vectors that would mathematically yield slightly >1 due to floating point
    const a = new Float32Array([1.0000001, 0]);
    const b = new Float32Array([1.0000001, 0]);
    const sim = cosineSimilarity(a, b);
    expect(sim).toBeLessThanOrEqual(1);
    expect(sim).toBeGreaterThanOrEqual(-1);
  });

  it("throws on dimension mismatch", () => {
    expect(() => cosineSimilarity(new Float32Array(3), new Float32Array(5))).toThrow(/length mismatch/);
  });
});

describe("EmbeddingDriftDetector", () => {
  let detector: EmbeddingDriftDetector;
  let embedFn: ReturnType<typeof vi.fn<(text: string) => Promise<Float32Array>>>;

  beforeEach(() => {
    embedFn = vi.fn<(text: string) => Promise<Float32Array>>();
    detector = new EmbeddingDriftDetector(embedFn);
  });

  it("returns drifting=false when output is empty", async () => {
    embedFn.mockResolvedValue(unitVector([1, 0, 0]));
    const result = await detector.detect("s1", "do the thing", "");
    expect(result.drifting).toBe(false);
    expect(result.similarity).toBe(1);
    // Output never embedded, only goal
    expect(embedFn).toHaveBeenCalledTimes(1);
  });

  it("flags drifting=true when similarity is below threshold", async () => {
    // Goal points one way, output points orthogonal direction (sim=0 < 0.35)
    embedFn.mockResolvedValueOnce(unitVector([1, 0, 0])); // goal
    embedFn.mockResolvedValueOnce(unitVector([0, 1, 0])); // output

    const result = await detector.detect("s1", "fix the bug", "writing essays about cats");
    expect(result.drifting).toBe(true);
    expect(result.similarity).toBeCloseTo(0, 6);
    expect(result.driftConfidence).toBeGreaterThan(0);
  });

  it("flags drifting=false when similarity is at or above threshold", async () => {
    // Make output nearly identical to goal (sim ~ 0.9)
    embedFn.mockResolvedValueOnce(unitVector([1, 0.1, 0]));
    embedFn.mockResolvedValueOnce(unitVector([1, 0.05, 0]));

    const result = await detector.detect("s1", "g", "o");
    expect(result.drifting).toBe(false);
    expect(result.similarity).toBeGreaterThan(0.35);
    expect(result.driftConfidence).toBe(0);
  });

  it("caches goal embedding by sessionId — second detect for same session re-embeds only output", async () => {
    embedFn.mockResolvedValue(unitVector([1, 0, 0]));

    await detector.detect("s1", "goal text", "out1");
    await detector.detect("s1", "goal text", "out2");

    // 1 goal embed + 2 output embeds = 3 total
    expect(embedFn).toHaveBeenCalledTimes(3);
  });

  it("evict() removes the cached goal so next detect re-embeds it", async () => {
    embedFn.mockResolvedValue(unitVector([1, 0, 0]));

    await detector.detect("s1", "goal", "out");
    detector.evict("s1");
    await detector.detect("s1", "goal", "out");

    // 2 goals + 2 outputs after evict
    expect(embedFn).toHaveBeenCalledTimes(4);
  });

  it("LRU evicts oldest entry when cache fills", async () => {
    embedFn.mockResolvedValue(unitVector([1, 0, 0]));
    const small = new EmbeddingDriftDetector(embedFn, {
      ...DEFAULT_EMBEDDING_DRIFT_CONFIG,
      cacheSize: 2,
    });

    await small.detect("a", "g", "out");
    await small.detect("b", "g", "out");
    embedFn.mockClear();

    // Inserting c should evict a (oldest)
    await small.detect("c", "g", "out");
    // Now re-detect a — goal must re-embed
    embedFn.mockClear();
    await small.detect("a", "g", "out");

    // 1 for new goal + 1 for output
    expect(embedFn).toHaveBeenCalledTimes(2);
  });

  it("windows output to last N chars (default 4000)", async () => {
    embedFn.mockResolvedValue(unitVector([1, 0, 0]));
    const huge = "X".repeat(10_000);

    await detector.detect("s1", "g", huge);
    // Output passed to embed should be the last 4000 chars
    const outputCall = embedFn.mock.calls[1][0] as string;
    expect(outputCall.length).toBe(4000);
  });

  it("driftConfidence is 0 when not drifting", async () => {
    embedFn.mockResolvedValueOnce(unitVector([1, 0, 0]));
    embedFn.mockResolvedValueOnce(unitVector([1, 0, 0]));
    const r = await detector.detect("s", "g", "o");
    expect(r.driftConfidence).toBe(0);
  });

  it("driftConfidence increases as similarity drops further below threshold", async () => {
    // First call: similarity just below threshold
    embedFn.mockResolvedValueOnce(unitVector([1, 0, 0]));
    embedFn.mockResolvedValueOnce(unitVector([0.34, 0.94, 0]));
    const close = await detector.detect("s_close", "g", "o");

    // Second call: opposite direction (sim = -1)
    embedFn.mockResolvedValueOnce(unitVector([1, 0, 0]));
    embedFn.mockResolvedValueOnce(unitVector([-1, 0, 0]));
    const far = await detector.detect("s_far", "g", "o");

    expect(far.driftConfidence).toBeGreaterThan(close.driftConfidence);
  });

  it("clear() removes all cached goals", async () => {
    embedFn.mockResolvedValue(unitVector([1, 0, 0]));
    await detector.detect("s1", "g", "o");
    await detector.detect("s2", "g", "o");
    detector.clear();
    embedFn.mockClear();

    await detector.detect("s1", "g", "o");
    // Both goal and output re-embedded
    expect(embedFn).toHaveBeenCalledTimes(2);
  });

  it("custom threshold config is respected", async () => {
    const strict = new EmbeddingDriftDetector(embedFn, {
      ...DEFAULT_EMBEDDING_DRIFT_CONFIG,
      similarityThreshold: 0.9,
    });
    embedFn.mockResolvedValueOnce(unitVector([1, 0, 0]));
    embedFn.mockResolvedValueOnce(unitVector([0.7, 0.7, 0])); // sim = 0.7

    const result = await strict.detect("s", "g", "o");
    expect(result.drifting).toBe(true); // 0.7 < 0.9
    expect(result.threshold).toBe(0.9);
  });
});
