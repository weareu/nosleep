/**
 * Cross-encoder rerank scaffold. Pluggable provider that reorders fused
 * candidates by query-candidate relevance. Default is a no-op (returns
 * null so the caller keeps the RRF order). A real bge-reranker-v2-m3 or
 * Haiku-LLM reranker drops in via `setRerankProvider`.
 */

export interface RerankCandidate {
  hash: string;
  text: string;
}

export interface RerankResult {
  hash: string;
  rank: number;
  score: number;
}

export interface RerankProvider {
  readonly name: string;
  rerank(
    query: string,
    candidates: RerankCandidate[],
  ): Promise<RerankResult[] | null>;
}

let current: RerankProvider | null = null;

export function setRerankProvider(provider: RerankProvider | null): void {
  current = provider;
}

/** Returns null when no provider is installed (caller keeps RRF order). */
export async function rerank(
  query: string,
  candidates: RerankCandidate[],
): Promise<RerankResult[] | null> {
  if (!current || candidates.length === 0 || !query) return null;
  try {
    return await current.rerank(query, candidates);
  } catch {
    return null;
  }
}
