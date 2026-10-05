/**
 * Bootstrap brain providers at server startup. Probes each optional
 * dependency once, registers a real provider when present, falls through
 * silently when not. Logs the active set so operators can see what's wired.
 *
 * Called from server.ts after registerBrain().
 */

import type { FastifyBaseLogger } from "fastify";
import { setImageProviders } from "./extractors/image-providers.js";
import { createExifrProvider } from "./extractors/exif-provider-exifr.js";
import {
  createTransformersClipProvider,
  isTransformersAvailable,
} from "./extractors/clip-provider-transformers.js";
import {
  createClaudeVisionProviders,
  isClaudeCliAvailable,
} from "./extractors/claude-vision-provider.js";
import {
  isTreeSitterAvailable,
} from "./extractors/code-symbols-treesitter.js";
import { isPdfParseAvailable } from "./extractors/pdf-handler.js";
import { resolveLlmRoute } from "../lib/headless-claude.js";

export interface BootstrapReport {
  exif: boolean;
  clip: boolean;
  claude_vision: boolean;
  tree_sitter: boolean;
  pdf_parse: boolean;
}

export async function bootstrapBrainProviders(
  logger?: FastifyBaseLogger,
): Promise<BootstrapReport> {
  const log = (msg: string, meta?: Record<string, unknown>) => {
    if (logger) logger.info(meta ?? {}, msg);
    else console.error(`[brain-bootstrap] ${msg}`, meta ?? "");
  };

  const report: BootstrapReport = {
    exif: false,
    clip: false,
    claude_vision: false,
    tree_sitter: false,
    pdf_parse: false,
  };

  // EXIF — instant probe + register
  try {
    const exif = await createExifrProvider();
    if (exif) {
      setImageProviders({ exif });
      report.exif = true;
    }
  } catch {
    /* keep going */
  }

  // CLIP — registers if @xenova/transformers is installed. Lazy: model
  // weights download on first embed, not here.
  try {
    if (await isTransformersAvailable()) {
      const clip = await createTransformersClipProvider();
      if (clip) {
        setImageProviders({ clip });
        report.clip = true;
      }
    }
  } catch {
    /* keep going */
  }

  // Vision — registers OCR + caption + scene as ONE round-trip. Backend per
  // NOSLEEP_LLM_*_VISION: openai (vision model configured) needs no CLI;
  // claude needs the CLI in PATH; off skips registration.
  try {
    const visionRoute = resolveLlmRoute("vision");
    if (
      visionRoute.provider === "openai" ||
      (visionRoute.provider === "claude" && (await isClaudeCliAvailable()))
    ) {
      const cv = createClaudeVisionProviders();
      setImageProviders({ ocr: cv.ocr, caption: cv.caption, scene: cv.scene });
      report.claude_vision = true;
    }
  } catch {
    /* keep going */
  }

  // Tree-sitter — probe only; the code-symbols extractor calls it on demand.
  try {
    report.tree_sitter = await isTreeSitterAvailable();
  } catch {
    /* keep going */
  }

  // PDF parse — probe only; pdf-handler imports it on demand.
  try {
    report.pdf_parse = await isPdfParseAvailable();
  } catch {
    /* keep going */
  }

  log("brain provider bootstrap complete", {
    active: Object.entries(report)
      .filter(([, v]) => v)
      .map(([k]) => k),
    inactive: Object.entries(report)
      .filter(([, v]) => !v)
      .map(([k]) => k),
  });
  return report;
}
