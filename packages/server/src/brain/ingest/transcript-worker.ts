/**
 * Worker-thread entry for transcript ingestion.
 *
 * ingestTranscript readFileSync's the whole JSONL transcript and runs the full
 * ingest pipeline per turn (hashing, artifact writes, FTS, extractor
 * scheduling). On the MAIN thread that blocked the event loop proportionally
 * to transcript size — a days-long interactive session's transcript produced a
 * 91-SECOND stall, which failed /health probes and got the server watchdog-
 * killed (2026-07-13 kick cluster). Here it runs off-thread; the pipeline is
 * self-contained (opens its own better-sqlite3 handles; WAL + busy_timeout
 * handle cross-thread writes) so the main thread only enqueues.
 *
 * Jobs are processed one at a time (message handler is synchronous) which
 * also bounds memory to one transcript at a time.
 */

import { parentPort } from "node:worker_threads";
import { ingestTranscript, type TranscriptIngestRequest } from "../hooks/transcript-ingest.js";
import { ingest } from "./pipeline.js";
import type { IngestRequestT } from "./types.js";
import { extractPdf } from "../extractors/pdf-handler.js";

interface WorkerJob {
  id: number;
  /** 'transcript' (default, back-compat) or 'artifacts' (single-turn batches
   *  from the hook routes — these blocked the MAIN thread up to 117s when a
   *  session posted a giant prompt/tool-result). */
  kind?: "transcript" | "artifacts" | "pdf";
  req?: TranscriptIngestRequest;
  items?: IngestRequestT[];
  /** 'pdf': raw PDF bytes. pdf.js text extraction is CPU-bound (and its
   *  first import alone blocked the main loop ~1.8s in the e2e). */
  data?: Uint8Array;
}

if (!parentPort) {
  throw new Error("transcript-worker must be started as a worker thread");
}

parentPort.on("message", (msg: WorkerJob) => {
  if (msg.kind === "pdf") {
    // Async job: other (synchronous) jobs keep flowing while pdf.js awaits.
    extractPdf(Buffer.from(msg.data ?? new Uint8Array())).then(
      (extraction) => parentPort!.postMessage({ id: msg.id, ok: true, result: { extraction } }),
      (err: unknown) =>
        parentPort!.postMessage({
          id: msg.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          errorName: err instanceof Error ? err.name : undefined,
        }),
    );
    return;
  }
  try {
    if (msg.kind === "artifacts") {
      const hashes: string[] = [];
      const errors: string[] = [];
      for (const item of msg.items ?? []) {
        try {
          hashes.push(ingest(item).hash);
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
      }
      parentPort!.postMessage({ id: msg.id, ok: true, result: { hashes, errors } });
      return;
    }
    const result = ingestTranscript(msg.req!);
    parentPort!.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    parentPort!.postMessage({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
