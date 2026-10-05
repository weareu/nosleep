/**
 * In-process extractor worker. Phase 2 ships the simplest viable scheduler:
 * fire-and-forget promises with a small concurrency cap. Phase 3+ can
 * migrate to worker_threads if the embedding/CLIP workers start contending
 * for CPU.
 */

import { runMetadataExtraction } from "./metadata-llm.js";
import { runTextEmbedding, type EmbedTarget } from "./embedding-text.js";
import { runEntityResolver } from "./entity-resolver.js";
import {
  runCodeSymbolExtractionAsync,
  type ExtractTarget as CodeSymbolTarget,
} from "./code-symbols.js";
import {
  runImageExtraction,
  type ImageExtractTarget,
} from "./image-extractor.js";
import { runAutoThoughtExtraction } from "./auto-thought.js";
import { activeDbFor } from "../storage/active-db.js";

let inflight = 0;
const MAX_PARALLEL = 4;
const queue: Array<() => Promise<void>> = [];

async function drain(): Promise<void> {
  while (inflight < MAX_PARALLEL && queue.length > 0) {
    const job = queue.shift();
    if (!job) break;
    inflight += 1;
    job()
      .catch(() => {
        /* extractor errors logged in extractor_runs */
      })
      .finally(() => {
        inflight -= 1;
        void drain();
      });
  }
}

/**
 * Schedule metadata extraction for a newly captured thought. Chains the
 * entity resolver after successful metadata extraction. Non-blocking.
 */
export async function scheduleMetadataExtraction(
  orgId: string,
  thoughtId: string,
): Promise<void> {
  queue.push(async () => {
    const ok = await runMetadataExtraction(orgId, thoughtId);
    if (ok) await runEntityResolver(orgId, thoughtId);
  });
  await drain();
}

/** Schedule entity resolver directly (useful for backfills or tests). */
export async function scheduleEntityResolver(
  orgId: string,
  thoughtId: string,
): Promise<void> {
  queue.push(() => runEntityResolver(orgId, thoughtId).then(() => undefined));
  await drain();
}

/** Schedule code symbol extraction for a code/* artifact. Non-blocking.
 *  Uses tree-sitter when the optional dep is installed, regex otherwise. */
export async function scheduleCodeSymbolExtraction(
  target: CodeSymbolTarget,
): Promise<void> {
  queue.push(() =>
    runCodeSymbolExtractionAsync(target)
      .then(() => undefined)
      .catch(() => undefined),
  );
  await drain();
}

/** Schedule image extraction (pHash/CLIP/OCR/scene/caption/EXIF). Non-blocking. */
export async function scheduleImageExtraction(
  target: ImageExtractTarget,
): Promise<void> {
  queue.push(() => runImageExtraction(target).then(() => undefined));
  await drain();
}

/**
 * Schedule text embedding for a thought or artifact. Non-blocking.
 *
 * ONNX inference is CPU-bound and runs on the MAIN event loop (no worker
 * thread yet), so under a flood of hook-ingest calls it stalls the loop
 * for tens of seconds and the server looks dead (recurring "is it running"
 * incident, 2026-06-08). Kill switch: set NOSLEEP_BRAIN_EMBED_INLINE=0 to
 * skip inline embedding entirely — artifacts/thoughts are still captured
 * and FTS-searchable, just not vector-indexed until a backfill runs. This
 * keeps the event loop responsive. Remove the guard once embedding moves
 * to a worker_thread.
 */
export async function scheduleTextEmbedding(target: EmbedTarget): Promise<void> {
  if (process.env.NOSLEEP_BRAIN_EMBED_INLINE === "0") return;
  queue.push(() => runTextEmbedding(target).then(() => undefined));
  await drain();
}

/**
 * Phase 11 — schedule auto-thought extraction for a conversation turn
 * artifact. On success, chain the metadata extractor + entity resolver +
 * thought-text embedding so the new thought is fully indexed.
 */
export async function scheduleAutoThoughtExtraction(opts: {
  org_id: string;
  artifact_hash: string;
}): Promise<void> {
  queue.push(async () => {
    try {
      const result = await runAutoThoughtExtraction({
        org_id: opts.org_id,
        artifact_hash: opts.artifact_hash,
      });
      if (!result.thought_id) return;

      // Schedule embedding FIRST so the thought becomes searchable even
      // if the metadata-LLM call later fails. Both schedule calls go
      // through the same queue+drain so ordering is the queue's call.
      const db = activeDbFor(opts.org_id);
      const row = db
        .prepare(
          `SELECT content, project_id FROM thoughts WHERE id = ? AND org_id = ?`,
        )
        .get(result.thought_id, opts.org_id) as
        | { content: string; project_id: string }
        | undefined;
      if (row) {
        await scheduleTextEmbedding({
          referrer_kind: "thought",
          hash: result.thought_id,
          text: row.content,
          project_id: row.project_id,
          org_id: opts.org_id,
        });
      }

      // Hand off to metadata-llm → entity resolver chain.
      await scheduleMetadataExtraction(opts.org_id, result.thought_id);
    } catch (err) {
      // Worker swallows but logs — the queue's outer drain handler also
      // catches but doesn't surface a reason. Visible in the server log.
      // eslint-disable-next-line no-console
      console.error(
        "[worker] auto-thought chain failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  });
  await drain();
}

/** Wait for queue to drain (tests). */
export async function waitForExtractorQueue(
  timeoutMs: number = 10_000,
): Promise<void> {
  const start = Date.now();
  while ((queue.length > 0 || inflight > 0) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** For tests that want to bypass the real Haiku call. */
export function __setMetadataExtractionHook(
  fn: (orgId: string, thoughtId: string) => Promise<boolean>,
): void {
  overrideFn = fn;
}

let overrideFn: ((orgId: string, thoughtId: string) => Promise<boolean>) | null =
  null;

// Re-wrap scheduleMetadataExtraction so tests can install a fast mock.
const realSchedule = scheduleMetadataExtraction;
export async function scheduleMetadataExtractionTestable(
  orgId: string,
  thoughtId: string,
): Promise<void> {
  if (overrideFn) {
    queue.push(async () => {
      await overrideFn!(orgId, thoughtId);
    });
    await drain();
    return;
  }
  return realSchedule(orgId, thoughtId);
}
