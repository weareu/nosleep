# Phase 5 — Visual + Code Modalities

> Full multi-modal retrieval. Images searchable by pHash, CLIP vector, OCR. Code searchable by AST symbol. PDF handler.

## Deliverable

- Image extractors: pHash, CLIP, OCR, scene classify, caption.
- `vec_clip` table populated.
- `image_features` fully written.
- Perceptual retriever (BK-tree in-process cache).
- Semantic image retriever (CLIP cosine).
- Code AST extractor (tree-sitter): `code_symbols` populated.
- Code-structural retriever.
- Large-blob CAS for media >1MB (filesystem path under `blobs/`).
- PDF handler (chunks PDF into `document/pdf_excerpt` artifacts).
- Web: `/brain/images` gallery with pHash clustering, `/brain/code` symbol/file history.
- Mobile: photo attach in Capture, image gallery mode, full Session detail, full Artifact detail.

## Depends on

Phase 3 (embeddings infrastructure exists).

## Key work items

1. pHash extractor using `sharp` + custom pHash or `@jimp/image-phash`.
2. CLIP extractor — `Xenova/clip-vit-base-patch32` via transformers.js, 512-dim. Populate `vec_clip_map` + `vec_clip`.
3. OCR extractor — `tesseract.js` local, run only for scene_class ∈ {ui, terminal, diagram} to avoid noise on photos.
4. Scene classifier — small local model (e.g. a CLIP-based prompt: "this is a ui screenshot / terminal / photo / diagram / chart"). Simple zero-shot classification.
5. Caption extractor — Haiku 4.5 with image input; produces 1-sentence caption + keywords.
6. EXIF extractor — `exif-parser` or `exifr`.
7. BK-tree for pHash in-memory cache (`packages/server/src/brain/retrieval/bk-tree.ts`): built once per process, rebuilt on change via change-detection. For 100K images: ~1 MB memory, <1 ms Hamming-ball query.
8. Tree-sitter code extractor (`extractors/code-ast.ts`): per-language parsers (ts, tsx, js, jsx, py, go, rust, java, c, cpp) → `code_symbols` rows.
9. Large-blob CAS: for artifact content > 1 MB, write to `data/brain/<org>/blobs/<hash[0:2]>/<hash>.zst` (zstd compressed), `artifacts.content` = NULL, `compression='zstd-cas'`. Resolver on read.
10. PDF handler (`extractors/pdf-handler.ts`): `pdf-parse` → per-page `document/pdf_excerpt` artifacts linked via `page_of_document` edge to parent `reference/link`.
11. Web: `/brain/images` masonry gallery (react-virtual + `react-photo-album`), pHash-cluster grouping, OCR search input, scene filter. `/brain/code` with symbol FTS + file history timeline.
12. Mobile: photo picker (`expo-image-picker`) in Capture, downscale to 2048px (`expo-image-manipulator`), upload. Gallery mode in Nav. Full SessionDetail screen with kind-aware renderers. Full ArtifactDetail with swipe-next.

## Files new

```
packages/server/src/brain/
  extractors/
    phash.ts
    clip.ts
    ocr.ts
    scene-classify.ts
    caption.ts
    exif.ts
    code-ast.ts
    pdf-handler.ts
  retrieval/
    bk-tree.ts
    retrievers/
      perceptual-image.ts
      semantic-image.ts
      code-structural.ts
  storage/
    cas-blobs.ts                # large-blob filesystem CAS
packages/web/src/pages/brain/
  Images.tsx
  Code.tsx
  components/
    MasonryGallery.tsx
    PhashClusterTile.tsx
    OcrSearchBar.tsx
    SymbolBrowser.tsx
    FileHistoryTimeline.tsx
packages/mobile/src/screens/brain/
  (extend CaptureScreen, RecentScreen)
  ImageGalleryScreen.tsx
  FullArtifactDetailScreen.tsx
  components/
    KindRendererNative.tsx       # mobile-optimized kind renderers
```

## Deps added

- `sharp`
- `tesseract.js`
- `exifr`
- `pdf-parse`
- `tree-sitter` + per-language grammars (`tree-sitter-typescript`, `tree-sitter-python`, etc.)
- `@xenova/transformers` (already in Phase 3 for embeddings; CLIP uses same pipeline)

## Performance

- pHash: ~30 ms per image (sharp resize + hash).
- CLIP encode: ~200 ms per image on CPU, ~50 ms on GPU/ANE.
- OCR: ~500 ms per terminal screenshot; ~1-3 s per full screenshot.
- Tree-sitter parse: ~5 ms per small file, ~50 ms per 10K-line file.
- Budget: image extraction runs async; freshly-captured images searchable within 10 s.

## Success criteria

- Capture a screenshot with error text → OCR extracts text → searchable by that text within 15 s.
- Upload the same image twice → dedup via content hash (existing); upload a near-dup (cropped) → pHash clusters them in gallery view.
- Search "function launchSession" → `code_symbols` hits across all `code/file_snapshot` and `code/diff` artifacts.
- PDF capture via URL full-mode → each page becomes searchable via text.
- Mobile: attach photo, capture with note, see it render in Recent within 5 s (online).

## Out of scope

- D3 graph (Phase 6)
- Admin/observability (Phase 7)
- HNSW (Phase 8)
- Bookmarklet/iOS share (Phase 9)
