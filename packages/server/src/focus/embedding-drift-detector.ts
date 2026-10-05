/**
 * Embedding-based drift detection.
 *
 * Compares the goal text against recent session output via cosine similarity
 * on L2-normalized embeddings. When similarity drops below a threshold, the
 * session is considered to have drifted off-topic.
 *
 * Cost: ~50-200ms per check on CPU (no API call) vs LLM-based detection
 * which costs $0.0005-0.001 + 1-2s latency per call.
 */

export interface EmbeddingDriftConfig {
  /** Cosine similarity below this threshold triggers a drift signal. */
  readonly similarityThreshold: number;
  /**
   * Maximum chars of recent output to include in the embedding.
   * Longer text dilutes the signal — last N chars usually represent the current trajectory.
   */
  readonly outputWindowChars: number;
  /** Cache size for goal embeddings (LRU eviction). */
  readonly cacheSize: number;
}

export const DEFAULT_EMBEDDING_DRIFT_CONFIG: EmbeddingDriftConfig = {
  similarityThreshold: 0.35,
  outputWindowChars: 4000,
  cacheSize: 64,
};

export interface EmbeddingDriftResult {
  readonly drifting: boolean;
  readonly similarity: number;
  readonly threshold: number;
  /** Higher is more confident the session is off-topic. */
  readonly driftConfidence: number;
}

/**
 * Cosine similarity between two L2-normalized vectors. Since the embedder
 * normalizes its output, this is just the dot product.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  // Clamp to [-1, 1] to defend against floating point drift
  if (sum > 1) return 1;
  if (sum < -1) return -1;
  return sum;
}

type EmbedFn = (text: string) => Promise<Float32Array>;

/**
 * Embedding-based drift detector. Holds an LRU cache of goal embeddings keyed
 * by session id so re-checks during a session don't re-embed the goal.
 */
export class EmbeddingDriftDetector {
  private readonly embed: EmbedFn;
  private readonly config: EmbeddingDriftConfig;
  // Map iteration order is insertion order — re-insert on hit to track recency
  private readonly goalCache = new Map<string, Float32Array>();

  constructor(embed: EmbedFn, config: EmbeddingDriftConfig = DEFAULT_EMBEDDING_DRIFT_CONFIG) {
    this.embed = embed;
    this.config = config;
  }

  /**
   * Returns drift result. Goal embeddings are cached per sessionId — subsequent
   * calls for the same session only re-embed the output.
   */
  async detect(sessionId: string, goalText: string, recentOutput: string): Promise<EmbeddingDriftResult> {
    const goalEmbedding = await this.getOrEmbedGoal(sessionId, goalText);
    const outputSnippet = this.windowOutput(recentOutput);

    if (outputSnippet.trim().length === 0) {
      // No output yet — can't drift from nothing
      return {
        drifting: false,
        similarity: 1,
        threshold: this.config.similarityThreshold,
        driftConfidence: 0,
      };
    }

    const outputEmbedding = await this.embed(outputSnippet);
    const similarity = cosineSimilarity(goalEmbedding, outputEmbedding);

    const drifting = similarity < this.config.similarityThreshold;
    // driftConfidence: how far below threshold (0 = at threshold, 1 = max drift)
    const range = this.config.similarityThreshold + 1; // similarity ranges [-1, threshold]
    const driftConfidence = drifting
      ? Math.min(1, (this.config.similarityThreshold - similarity) / range)
      : 0;

    return {
      drifting,
      similarity,
      threshold: this.config.similarityThreshold,
      driftConfidence,
    };
  }

  /** Drop a session's cached goal — call when the session ends. */
  evict(sessionId: string): void {
    this.goalCache.delete(sessionId);
  }

  /** Clear the entire cache. Useful for tests. */
  clear(): void {
    this.goalCache.clear();
  }

  private windowOutput(text: string): string {
    if (text.length <= this.config.outputWindowChars) return text;
    return text.slice(-this.config.outputWindowChars);
  }

  private async getOrEmbedGoal(sessionId: string, goalText: string): Promise<Float32Array> {
    const existing = this.goalCache.get(sessionId);
    if (existing) {
      // Touch for LRU recency
      this.goalCache.delete(sessionId);
      this.goalCache.set(sessionId, existing);
      return existing;
    }
    const embedding = await this.embed(goalText);
    if (this.goalCache.size >= this.config.cacheSize) {
      // Evict the oldest entry
      const oldest = this.goalCache.keys().next().value;
      if (oldest !== undefined) {
        this.goalCache.delete(oldest);
      }
    }
    this.goalCache.set(sessionId, embedding);
    return embedding;
  }
}
