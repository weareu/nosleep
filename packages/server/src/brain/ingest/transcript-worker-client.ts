/**
 * Main-thread client for the transcript-ingest worker.
 *
 * Owns a single lazy-spawned worker thread and a promise map keyed by job id.
 * If the worker can't boot (loader issue, missing file) it falls back to the
 * inline (main-thread) ingest ONCE PER CALL with a loud log — degraded but
 * functional beats silently dropping transcripts. If the worker crashes, all
 * in-flight jobs reject and the next call respawns it.
 */

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildSync } from "esbuild";
import { getLogger } from "../../logger.js";
import type { TranscriptIngestRequest, TranscriptIngestResult } from "../hooks/transcript-ingest.js";

const log = getLogger("transcript-worker");

/**
 * Bundle the worker (TS + its workspace import graph) into ONE plain-ESM file
 * so the Worker thread needs no TS loader. tsx's .js→.ts alias does NOT apply
 * inside worker threads (verified: entry transforms, dependency resolution
 * fails), so loader-based approaches are dead ends. `packages: "external"`
 * keeps native deps (better-sqlite3, sqlite-vec, onnxruntime-node) resolving
 * from node_modules at runtime. Built lazily once per boot (~100ms).
 */
function bundleWorker(): string {
  const entry = fileURLToPath(new URL("./transcript-worker.ts", import.meta.url));
  const outfile = join(dirname(entry), "../../../.worker-dist/transcript-worker.mjs");
  mkdirSync(dirname(outfile), { recursive: true });
  buildSync({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    sourcemap: "inline",
    logLevel: "silent",
  });
  return outfile;
}

// A 2.8GB-transcript pathological case still shouldn't wedge a job slot
// forever; the worker processes serially so this bounds the whole queue.
const JOB_TIMEOUT_MS = 10 * 60_000;

interface Pending {
  resolve: (r: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Deterministic unit tests must not bundle+spawn a real worker.
const FORCE_INLINE = process.env.NOSLEEP_INGEST_INLINE === "1" || Boolean(process.env.VITEST);

let worker: Worker | null = null;
let workerBootFailed = false;
let seq = 0;
const pending = new Map<number, Pending>();

function failAllPending(err: Error): void {
  for (const [id, job] of pending) {
    clearTimeout(job.timer);
    job.reject(err);
    pending.delete(id);
  }
}

function spawnWorker(): Worker | null {
  if (workerBootFailed) return null;
  try {
    const bundled = bundleWorker();
    const w = new Worker(bundled);

    w.on("message", (msg: { id: number; ok: boolean; result?: unknown; error?: string; errorName?: string }) => {
      const job = pending.get(msg.id);
      if (!job) return;
      pending.delete(msg.id);
      clearTimeout(job.timer);
      if (msg.ok && msg.result) job.resolve(msg.result);
      else {
        const err = new Error(msg.error ?? "worker ingest failed");
        if (msg.errorName) err.name = msg.errorName;
        job.reject(err);
      }
    });

    w.on("error", (err: Error) => {
      log.error({ err: err.message }, "transcript worker errored — failing in-flight jobs, will respawn");
      failAllPending(err);
      worker = null;
    });

    w.on("exit", (code) => {
      if (code !== 0) {
        log.error({ code }, "transcript worker exited abnormally");
        failAllPending(new Error(`transcript worker exited with code ${code}`));
      }
      worker = null;
    });

    // Don't hold the process open on shutdown.
    w.unref();
    return w;
  } catch (err) {
    workerBootFailed = true;
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      "transcript worker FAILED TO BOOT — falling back to main-thread ingest (event-loop stalls will return; investigate!)",
    );
    return null;
  }
}

/**
 * Ingest a transcript off-thread. Falls back to inline ingest when the worker
 * is unavailable.
 */
export async function ingestTranscriptOffThread(
  req: TranscriptIngestRequest,
): Promise<TranscriptIngestResult> {
  if (!FORCE_INLINE && !worker) worker = spawnWorker();
  if (FORCE_INLINE || !worker) {
    const { ingestTranscript } = await import("../hooks/transcript-ingest.js");
    return ingestTranscript(req);
  }

  const id = ++seq;
  return new Promise<TranscriptIngestResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`transcript ingest timed out after ${JOB_TIMEOUT_MS / 60000}m: ${req.transcript_path}`));
    }, JOB_TIMEOUT_MS);
    pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer });
    worker!.postMessage({ id, req });
  });
}

export interface ArtifactBatchResult {
  hashes: string[];
  errors: string[];
}

// Single-turn batches are small; if the worker queue can't turn one around in
// 2 minutes something is deeply wrong — fail the promise, the hook is
// fire-and-forget anyway.
const ARTIFACT_JOB_TIMEOUT_MS = 2 * 60_000;

/**
 * Ingest a batch of artifacts (single-turn hook payloads) off-thread. These
 * previously ran pipeline.ingest() on the MAIN thread inside the hook routes
 * and blocked the event loop up to 117s when a session posted a giant
 * prompt/tool-result. Inline fallback when the worker is unavailable.
 */
export async function ingestArtifactsOffThread(
  items: import("./types.js").IngestRequestT[],
): Promise<ArtifactBatchResult> {
  if (items.length === 0) return { hashes: [], errors: [] };
  if (!FORCE_INLINE && !worker) worker = spawnWorker();
  if (FORCE_INLINE || !worker) {
    const { ingest } = await import("./pipeline.js");
    const out: ArtifactBatchResult = { hashes: [], errors: [] };
    for (const item of items) {
      try {
        out.hashes.push(ingest(item).hash);
      } catch (err) {
        out.errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    return out;
  }

  const id = ++seq;
  return new Promise<ArtifactBatchResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`artifact ingest timed out after ${ARTIFACT_JOB_TIMEOUT_MS / 60000}m (${items.length} items)`));
    }, ARTIFACT_JOB_TIMEOUT_MS);
    pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer });
    worker!.postMessage({ id, kind: "artifacts", items });
  });
}

const PDF_JOB_TIMEOUT_MS = 2 * 60_000;

/**
 * Extract PDF text off the main thread (same worker, async job). Returns null
 * when pdf-parse is unavailable; throws PdfExtractionError on unreadable
 * input — identical contract to extractPdf. Inline fallback when the worker
 * is unavailable (and under vitest).
 */
export async function extractPdfOffThread(
  buffer: Buffer,
): Promise<import("../extractors/pdf-handler.js").PdfExtraction | null> {
  const { extractPdf, PdfExtractionError } = await import("../extractors/pdf-handler.js");
  if (!FORCE_INLINE && !worker) worker = spawnWorker();
  if (FORCE_INLINE || !worker) return extractPdf(buffer);

  const id = ++seq;
  const result = await new Promise<{ extraction: import("../extractors/pdf-handler.js").PdfExtraction | null }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`PDF extraction timed out after ${PDF_JOB_TIMEOUT_MS / 60000}m (${buffer.length} bytes)`));
      }, PDF_JOB_TIMEOUT_MS);
      pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer });
      worker!.postMessage({ id, kind: "pdf", data: new Uint8Array(buffer) });
    },
  ).catch((err: Error) => {
    if (err.name === "PdfExtractionError") throw new PdfExtractionError(err.message);
    throw err;
  });
  return result.extraction;
}

/** Test hook: tear down the worker between tests. */
export async function __shutdownTranscriptWorker(): Promise<void> {
  failAllPending(new Error("worker shut down"));
  if (worker) {
    await worker.terminate();
    worker = null;
  }
  workerBootFailed = false;
}
