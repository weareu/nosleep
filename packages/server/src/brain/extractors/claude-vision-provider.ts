/**
 * Claude-vision provider for OCR + caption + scene classification. One
 * Haiku call with image input returns a structured JSON payload that
 * populates all three image-provider extractors at once.
 *
 * Reuses the local claude CLI's Pro/Max auth — no separate API key needed.
 *
 * Install requirements: claude CLI v2.1+ with --image support. If absent
 * or if vision isn't supported for the model, each provider returns null
 * and the rest of the pipeline carries on.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type {
  OcrProvider,
  CaptionProvider,
  SceneClassifier,
} from "./image-providers.js";
import { canSpawnHaiku, recordHaikuSpawn } from "../haiku-budget.js";
// Routing (NOSLEEP_LLM_*_VISION, see resolveLlmRoute): "claude" stays on the
// CLI path (runClaudeHeadless — image input needs --image; the SDK query()
// image route requires content-block streaming input). "openai" sends the
// image to an OpenAI-compatible vision model via headlessQuery. "off" (openai
// selected but no NOSLEEP_LLM_MODEL_VISION) skips vision entirely.
import {
  headlessQuery,
  resolveLlmRoute,
  runClaudeHeadless,
  type LlmRoute,
} from "../../lib/headless-claude.js";

const MODEL = "claude-haiku-4-5";
const TIMEOUT_MS = 60_000;

const PROMPT = `You are analysing a single image. Return a STRICT JSON object with these keys:
{
  "ocr_text": "<any visible text transcribed verbatim, or empty string>",
  "caption": "<one-sentence description of what the image shows>",
  "scene_class": "<one of: ui, terminal, photo, diagram, chart, code, whiteboard, mixed, unknown>"
}
Return ONLY the JSON object. No preamble, no code fences.`;

interface CachedResult {
  ocr_text: string;
  caption: string;
  scene_class: string;
}

const cache = new Map<string, Promise<CachedResult | null>>();

function cacheKey(buffer: Buffer): string {
  return `${buffer.length}:${buffer[0] ?? 0}:${buffer[buffer.length - 1] ?? 0}`;
}

async function callClaudeVision(buffer: Buffer): Promise<CachedResult | null> {
  let route: LlmRoute;
  try {
    route = resolveLlmRoute("vision");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[claude-vision] ${(err as Error).message}`);
    return null;
  }
  if (route.provider === "off") return null;
  if (!canSpawnHaiku()) return null;
  recordHaikuSpawn();
  if (route.provider === "openai") {
    try {
      const stdout = await headlessQuery({
        prompt: PROMPT,
        model: MODEL,
        timeoutMs: TIMEOUT_MS,
        brainInternal: true,
        purpose: "vision",
        images: [buffer],
      });
      return parseVisionResult(stdout);
    } catch {
      return null;
    }
  }
  // Write to a temp file so --image can read by path.
  const tmp = path.join(
    os.tmpdir(),
    `nosleep-vision-${randomBytes(8).toString("hex")}.bin`,
  );
  try {
    fs.writeFileSync(tmp, buffer);
    const { stdout } = await runClaudeHeadless(
      [
        "--print",
        "--model",
        MODEL,
        "--output-format",
        "text",
        "--max-turns",
        "1",
        "--image",
        tmp,
        PROMPT,
      ],
      {
        timeoutMs: TIMEOUT_MS,
        env: { ...process.env, NOSLEEP_BRAIN_INTERNAL: "1" },
      },
    );
    return parseVisionResult(stdout);
  } catch {
    return null;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

/** Throws on malformed JSON — callers' catch turns that into null. */
function parseVisionResult(stdout: string): CachedResult | null {
  const block = extractJsonBlock(stdout);
  if (!block) return null;
  const parsed = JSON.parse(block) as Partial<CachedResult>;
  return {
    ocr_text: typeof parsed.ocr_text === "string" ? parsed.ocr_text : "",
    caption: typeof parsed.caption === "string" ? parsed.caption : "",
    scene_class:
      typeof parsed.scene_class === "string" ? parsed.scene_class : "unknown",
  };
}

function extractJsonBlock(text: string): string | null {
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(text);
  if (fenced) return fenced[1];
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return text.slice(first, last + 1);
}

function analyse(buffer: Buffer): Promise<CachedResult | null> {
  const key = cacheKey(buffer);
  const hit = cache.get(key);
  if (hit) return hit;
  const promise = callClaudeVision(buffer);
  cache.set(key, promise);
  // Keep cache bounded — drop after 60s
  setTimeout(() => cache.delete(key), 60_000).unref();
  return promise;
}

/**
 * Check whether the claude CLI is available with a simple --version probe.
 * Doesn't guarantee vision support — that only surfaces on actual use.
 */
export async function isClaudeCliAvailable(): Promise<boolean> {
  try {
    await runClaudeHeadless(["--version"], { timeoutMs: 3_000 });
    return true;
  } catch {
    return false;
  }
}

export interface ClaudeVisionProviders {
  ocr: OcrProvider;
  caption: CaptionProvider;
  scene: SceneClassifier;
}

/**
 * Construct OCR + caption + scene providers backed by a single Haiku call.
 * The three providers share a request cache so extracting all three on the
 * same image only makes one network/CLI round-trip.
 */
export function createClaudeVisionProviders(): ClaudeVisionProviders {
  return {
    ocr: {
      name: "claude-vision-ocr",
      async recognise(buffer: Buffer): Promise<string | null> {
        const r = await analyse(buffer);
        return r?.ocr_text ? r.ocr_text : null;
      },
    },
    caption: {
      name: "claude-vision-caption",
      async caption(buffer: Buffer): Promise<string | null> {
        const r = await analyse(buffer);
        return r?.caption ? r.caption : null;
      },
    },
    scene: {
      name: "claude-vision-scene",
      async classify(buffer: Buffer): Promise<string | null> {
        const r = await analyse(buffer);
        return r?.scene_class ? r.scene_class : null;
      },
    },
  };
}
