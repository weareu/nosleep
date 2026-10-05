/**
 * CLIP image-embedding provider using @xenova/transformers. Lazily loads
 * the Xenova/clip-vit-base-patch32 model (~150MB, cached in ~/.cache after
 * first run). Returns null when the optional dep is missing so callers can
 * fall back to other providers or no-op.
 *
 * Install (optional):
 *   npm install @xenova/transformers
 *
 * Then wire in your application bootstrap:
 *   setImageProviders({ clip: await createTransformersClipProvider() });
 */

import { createRequire } from "node:module";
import type { ClipProvider } from "./image-providers.js";

const require = createRequire(import.meta.url);

const MODEL = "Xenova/clip-vit-base-patch32";
const EMBED_DIM = 512;

/**
 * Probe whether @xenova/transformers is installed WITHOUT importing it.
 * `import()` triggers the ONNX/WASM backend init, a ~30s synchronous block on
 * the main event loop — and the bootstrap used to do it twice per boot, which
 * froze /health long enough to trip the watchdog. require.resolve only checks
 * module resolution on disk (instant); the heavy import stays lazy in
 * loadPipeline(), paid once on the first actual image embed.
 */
function transformersInstalled(): boolean {
  try {
    require.resolve("@xenova/transformers");
    return true;
  } catch {
    return false;
  }
}

type Pipeline = (
  input: unknown,
  options?: { pooling?: string; normalize?: boolean },
) => Promise<{ data: Float32Array }>;

let cachedPipeline: Pipeline | null = null;

async function loadPipeline(): Promise<Pipeline | null> {
  if (cachedPipeline) return cachedPipeline;
  try {
    const mod = (await import("@xenova/transformers" as string)) as unknown as {
      pipeline(task: string, model: string, opts?: unknown): Promise<Pipeline>;
    };
    cachedPipeline = await mod.pipeline("image-feature-extraction", MODEL);
    return cachedPipeline;
  } catch {
    return null;
  }
}

/**
 * Returns a ClipProvider, or null when @xenova/transformers isn't installed.
 * Lazy — the model itself loads on first embed() call, not here.
 */
export async function createTransformersClipProvider(): Promise<ClipProvider | null> {
  // Probe availability without loading the model (no heavy ONNX/WASM init)
  if (!transformersInstalled()) return null;

  return {
    name: "xenova-clip-vit-base-patch32",
    dim: EMBED_DIM,
    async embed(buffer: Buffer): Promise<Float32Array | null> {
      const pipeline = await loadPipeline();
      if (!pipeline) return null;
      try {
        // transformers.js accepts a Buffer/ArrayBuffer directly for images in
        // Node; it uses its own RawImage decoder under the hood.
        const result = await pipeline(buffer, {
          pooling: "mean",
          normalize: true,
        });
        if (result?.data instanceof Float32Array && result.data.length === EMBED_DIM) {
          // Copy to detach from the pipeline's internal buffer
          return new Float32Array(result.data);
        }
        return null;
      } catch {
        return null;
      }
    },
  };
}

/** True when @xenova/transformers is resolvable in the current env.
 *  Resolution-only check — does not import (and thus does not init) the lib. */
export async function isTransformersAvailable(): Promise<boolean> {
  return transformersInstalled();
}
