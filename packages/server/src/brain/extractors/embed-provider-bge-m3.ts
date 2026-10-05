/**
 * Phase 12 (G1) — bge-m3 1024-dim embedding provider via @xenova/transformers.
 *
 * Locked decision #37 prescribes bge-m3 1024-dim, but the existing pipeline
 * uses minilm 384-dim. This provider runs alongside minilm; vectors land
 * in vec_text_1024 (separate vec0 table). Becomes the default once a
 * full re-embed backfill is run.
 *
 * Optional dep — falls back to null when @xenova/transformers isn't
 * installed or the model file isn't downloaded.
 */

import type { EmbedProvider } from "./embed-provider.js";

let provider: EmbedProvider | null | undefined;

interface XenovaModule {
  pipeline(
    task: string,
    model: string,
    opts?: Record<string, unknown>,
  ): Promise<
    (input: string, opts?: Record<string, unknown>) => Promise<{ data: Float32Array }>
  >;
}

export async function getBgeM3Provider(): Promise<EmbedProvider | null> {
  if (provider !== undefined) return provider;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = (await import("@xenova/transformers")) as unknown as XenovaModule;
    const extractor = await mod.pipeline(
      "feature-extraction",
      "Xenova/bge-m3",
    );
    provider = {
      name: "bge-m3",
      dim: 1024,
      async embed(text: string): Promise<Float32Array> {
        const out = await extractor(text, {
          pooling: "mean",
          normalize: true,
        });
        return out.data;
      },
    };
    return provider;
  } catch (e) {
    void e;
    provider = null;
    return null;
  }
}

/** Test reset. */
export function __resetBgeM3Provider(): void {
  provider = undefined;
}
