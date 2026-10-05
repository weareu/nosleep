/**
 * Reciprocal Rank Fusion. Combines ranked lists from N retrievers into a
 * single fused ranking. Robust to score-scale differences; documents present
 * in only one retriever are not penalised.
 *
 *   score(d) = Σ_m  w_m · 1 / (k + rank_m(d))
 *
 * Phase 1 fuses just BM25 + temporal. Phase 3 adds semantic + cross-encoder.
 */

import type { RetrieverResult } from "./retrievers/bm25.js";

export interface FusedResult {
  hash: string;
  fused_score: number;
  fused_rank: number;
  contributions: Record<string, { rank: number; raw_score: number; weight: number }>;
}

export interface RrfInput {
  retriever: string;
  results: RetrieverResult[];
  weight: number;
}

export function rrf(
  inputs: RrfInput[],
  k: number = 60,
  topK: number = 100,
): FusedResult[] {
  const byHash = new Map<string, FusedResult>();

  for (const input of inputs) {
    for (const r of input.results) {
      const existing = byHash.get(r.hash);
      const contribution = input.weight * (1 / (k + r.rank));
      if (existing) {
        existing.fused_score += contribution;
        existing.contributions[input.retriever] = {
          rank: r.rank,
          raw_score: r.raw_score,
          weight: input.weight,
        };
      } else {
        byHash.set(r.hash, {
          hash: r.hash,
          fused_score: contribution,
          fused_rank: 0,
          contributions: {
            [input.retriever]: {
              rank: r.rank,
              raw_score: r.raw_score,
              weight: input.weight,
            },
          },
        });
      }
    }
  }

  const sorted = [...byHash.values()].sort(
    (a, b) => b.fused_score - a.fused_score,
  );
  sorted.forEach((r, i) => {
    r.fused_rank = i + 1;
  });
  return sorted.slice(0, topK);
}
