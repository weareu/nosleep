# Optional Extractor Dependencies

The brain ships pluggable extractor scaffolds that degrade gracefully when
their heavy native or model-bundling deps aren't installed. This doc lists
the optional packages and what each unlocks.

None of these are required for V1 brain to work — they upgrade quality when
enabled.

## Current defaults (no install needed)

| Extractor | Default impl | Quality |
|---|---|---|
| Text embeddings | `minilm-l6-v2` ONNX (already shipped) | Good (384-dim) |
| Metadata LLM | `claude --print` CLI (already shipped) | own prompt with extended types |
| Code symbols | regex (ships) | ~80% coverage |
| URL ref/full | native fetch + regex + heuristic body | Works for HTML |
| FTS + BM25 | sqlite FTS5 (ships) | Production-grade |
| pHash / CLIP / OCR / scene / caption / EXIF | no-op scaffolds | Data gets marked `skipped` |
| Tree-sitter code parser | — | Not wired |

## Optional upgrades

### `web-tree-sitter` + `tree-sitter-wasms` — real AST code parsing

```bash
npm install web-tree-sitter tree-sitter-wasms
```

Upgrades `code-symbols` from regex to full AST. Covers more edge cases
(nested classes, destructured exports, decorators, generics). No user
action beyond install — `code-symbols-treesitter.ts` picks it up via
dynamic import on first code ingest.

Supported languages out-of-the-box via `tree-sitter-wasms`: typescript,
tsx, javascript, python, go, rust, java, ruby.

### `@xenova/transformers` — CLIP image embeddings

```bash
npm install @xenova/transformers
```

Unlocks semantic image search. Model (~150MB `clip-vit-base-patch32`)
downloads on first use and caches to `~/.cache/huggingface`. To enable in
your bootstrap:

```typescript
import { createTransformersClipProvider } from "@nosleep/server/brain/extractors/clip-provider-transformers.js";
import { setImageProviders } from "@nosleep/server/brain/extractors/image-providers.js";

const clip = await createTransformersClipProvider();
if (clip) setImageProviders({ clip });
```

After this, every `media/image/*` artifact gets a 512-dim CLIP vector in
`vec_clip`, and `runSemanticImage` returns real cosine matches.

### Other planned providers (not yet shipped)

| Package | Unlocks | Notes |
|---|---|---|
| `exifr` | Real EXIF (GPS, camera, date, orientation) for JPEGs/HEIC | ~30KB pure JS |
| `pdf-parse` | `document/pdf_excerpt` per-page text | ~200KB pure JS |
| `tesseract.js` | OCR fallback when Haiku vision isn't available | Slow; Haiku vision preferred |
| Native `sharp` | Fast pHash via DCT on resized thumbnail | Needs native build |
| `claude --print --image` | Haiku vision for OCR + caption + scene in one call | Uses existing Pro/Max auth; no API key |

Each drops in behind the same `setImageProviders()` interface when
implemented.

## Probing availability at runtime

```typescript
import { isTreeSitterAvailable } from "@nosleep/server/brain/extractors/code-symbols-treesitter.js";
import { isTransformersAvailable } from "@nosleep/server/brain/extractors/clip-provider-transformers.js";

console.log("tree-sitter:", await isTreeSitterAvailable());
console.log("transformers.js:", await isTransformersAvailable());
```

## Fallback guarantees

Every optional dep follows the same pattern:

- Dynamic `import()` wrapped in try/catch.
- Missing dep → provider function returns `null` OR extractor returns
  "skipped" to `extractor_runs`.
- Existing no-op / regex paths continue to work.
- Never a hard crash on missing dep.

Tests verify this: `phase5.test.ts` exercises the fallback path with no
optional deps installed in CI.
