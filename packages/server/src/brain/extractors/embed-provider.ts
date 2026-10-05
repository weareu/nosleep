/**
 * Pluggable embedding provider. The production default forwards to the
 * existing minilm-l6-v2 embedder shipped in packages/server/src/embeddings.
 * Tests (and alternative deployments) can install a different provider via
 * `setEmbedProvider`.
 *
 * Dim is fixed at 384 to match the vec_text virtual table.
 */

export const EMBED_DIM = 384;

export interface EmbedProvider {
  readonly name: string;
  readonly dim: number;
  embed(text: string): Promise<Float32Array>;
}

class DefaultMinilmProvider implements EmbedProvider {
  readonly name = "minilm-l6-v2";
  readonly dim = EMBED_DIM;

  async embed(text: string): Promise<Float32Array> {
    // Lazy import so the ONNX model only loads when actually invoked.
    const { embed } = await import("../../embeddings/embedder.js");
    return embed(text);
  }
}

let current: EmbedProvider | null = null;

export function getEmbedProvider(): EmbedProvider {
  if (!current) current = new DefaultMinilmProvider();
  return current;
}

export function setEmbedProvider(provider: EmbedProvider | null): void {
  current = provider;
}

/**
 * Short content stays as one chunk. Longer content chunked at 256-token
 * approximations (1 word ≈ 1.3 tokens). Stride 128 words for overlap.
 */
export function chunkForEmbedding(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 256) return [text.trim()];
  const chunks: string[] = [];
  const size = 256;
  const stride = 128;
  for (let i = 0; i < words.length; i += stride) {
    const slice = words.slice(i, i + size);
    if (slice.length === 0) break;
    chunks.push(slice.join(" "));
    if (i + size >= words.length) break;
  }
  return chunks;
}
