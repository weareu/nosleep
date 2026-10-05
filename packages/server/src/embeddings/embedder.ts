import { createRequire } from "node:module";
import type * as Ort from "onnxruntime-node";
const require = createRequire(import.meta.url);
const ort = require("onnxruntime-node") as typeof import("onnxruntime-node");
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MODELS_DIR = join(process.cwd(), "data", "models");
const MODEL_PATH = join(MODELS_DIR, "minilm-l6-v2.onnx");
const TOKENIZER_PATH = join(MODELS_DIR, "tokenizer.json");
const EMBEDDING_DIM = 384;
const MAX_SEQ_LEN = 128;

// ── Minimal WordPiece Tokenizer ──────────────────────────

interface TokenizerData {
  model: {
    vocab: Record<string, number>;
  };
}

let vocab: Map<string, number> | null = null;
let unkId = 0;
let clsId = 101;
let sepId = 102;

function loadVocab(): Map<string, number> {
  if (vocab) return vocab;
  const data = JSON.parse(readFileSync(TOKENIZER_PATH, "utf-8")) as TokenizerData;
  vocab = new Map(Object.entries(data.model.vocab));
  unkId = vocab.get("[UNK]") ?? 0;
  clsId = vocab.get("[CLS]") ?? 101;
  sepId = vocab.get("[SEP]") ?? 102;
  return vocab;
}

function tokenize(text: string): number[] {
  const v = loadVocab();
  const tokens: number[] = [clsId];

  // Basic pre-tokenization: lowercase, split on whitespace and punctuation
  const words = text.toLowerCase().replace(/[^\w\s]/g, " $& ").split(/\s+/).filter(Boolean);

  for (const word of words) {
    if (tokens.length >= MAX_SEQ_LEN - 1) break;

    // WordPiece: try whole word first, then progressively split with ##
    let remaining = word;
    let isFirst = true;

    while (remaining.length > 0 && tokens.length < MAX_SEQ_LEN - 1) {
      let found = false;
      for (let end = remaining.length; end > 0; end--) {
        const sub = isFirst ? remaining.slice(0, end) : `##${remaining.slice(0, end)}`;
        if (v.has(sub)) {
          tokens.push(v.get(sub)!);
          remaining = remaining.slice(end);
          isFirst = false;
          found = true;
          break;
        }
      }
      if (!found) {
        tokens.push(unkId);
        break;
      }
    }
  }

  tokens.push(sepId);
  return tokens;
}

// ── ONNX Inference ───────────────────────────────────────

let session: Ort.InferenceSession | null = null;

async function getSession(): Promise<Ort.InferenceSession> {
  if (session) return session;
  session = await ort.InferenceSession.create(MODEL_PATH, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
  });
  return session;
}

/**
 * Generate a 384-dim embedding for a text string.
 * Uses all-MiniLM-L6-v2 (22MB quantized ONNX model).
 */
export async function embed(text: string): Promise<Float32Array> {
  const sess = await getSession();
  const ids = tokenize(text);
  const seqLen = ids.length;

  const inputIds = new BigInt64Array(ids.map(id => BigInt(id)));
  const attentionMask = new BigInt64Array(ids.map(() => BigInt(1)));
  const tokenTypeIds = new BigInt64Array(ids.map(() => BigInt(0)));

  const feeds = {
    input_ids: new ort.Tensor("int64", inputIds, [1, seqLen]),
    attention_mask: new ort.Tensor("int64", attentionMask, [1, seqLen]),
    token_type_ids: new ort.Tensor("int64", tokenTypeIds, [1, seqLen]),
  };

  const results = await sess.run(feeds);
  const output = Object.values(results)[0] as Ort.Tensor;
  const data = output.data as Float32Array;
  const dims = output.dims; // [1, seqLen, 384]
  const embDim = dims[2] as number;

  // Mean pooling
  const embedding = new Float32Array(embDim);
  for (let d = 0; d < embDim; d++) {
    let sum = 0;
    for (let t = 0; t < seqLen; t++) {
      sum += data[t * embDim + d];
    }
    embedding[d] = sum / seqLen;
  }

  // L2 normalize
  let norm = 0;
  for (let d = 0; d < embDim; d++) norm += embedding[d] * embedding[d];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let d = 0; d < embDim; d++) embedding[d] /= norm;
  }

  return embedding;
}

/**
 * Batch embed multiple texts.
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  // Sequential for now — ONNX batching is more complex
  const results: Float32Array[] = [];
  for (const text of texts) {
    results.push(await embed(text));
  }
  return results;
}

export { EMBEDDING_DIM };
