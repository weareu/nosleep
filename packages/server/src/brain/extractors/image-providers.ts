/**
 * Pluggable providers for image-related extractors. Each provider is a
 * thin interface; the default export is a no-op that records "skipped" to
 * extractor_runs. Real providers drop in via `setImageProviders()` when
 * their deps are available (sharp for pHash, transformers.js for CLIP,
 * tesseract.js for OCR, Haiku with image input for caption).
 *
 * This lets the pipeline enqueue the right jobs today without owning the
 * heavy model dependencies yet.
 */

export interface PhashProvider {
  readonly name: string;
  /** Returns a 64-bit integer perceptual hash, or null if unsupported. */
  compute(buffer: Buffer): Promise<bigint | null>;
}

export interface ClipProvider {
  readonly name: string;
  readonly dim: number; // typically 512
  /** Returns a CLIP image embedding or null if unsupported. */
  embed(buffer: Buffer): Promise<Float32Array | null>;
}

export interface OcrProvider {
  readonly name: string;
  /** Returns plain-text OCR output, or null if unsupported. */
  recognise(buffer: Buffer): Promise<string | null>;
}

export interface SceneClassifier {
  readonly name: string;
  /** Returns one of: ui | photo | diagram | chart | terminal | unknown. */
  classify(buffer: Buffer): Promise<string | null>;
}

export interface CaptionProvider {
  readonly name: string;
  /** Returns a one-sentence caption, or null if unsupported. */
  caption(buffer: Buffer): Promise<string | null>;
}

export interface ExifProvider {
  readonly name: string;
  /** Returns structured EXIF metadata, or null if unsupported. */
  extract(buffer: Buffer): Promise<Record<string, unknown> | null>;
}

export interface ImageProviders {
  phash: PhashProvider | null;
  clip: ClipProvider | null;
  ocr: OcrProvider | null;
  scene: SceneClassifier | null;
  caption: CaptionProvider | null;
  exif: ExifProvider | null;
}

const none: ImageProviders = {
  phash: null,
  clip: null,
  ocr: null,
  scene: null,
  caption: null,
  exif: null,
};

let current: ImageProviders = { ...none };

export function getImageProviders(): ImageProviders {
  return current;
}

/** Install one or more image providers. Pass null fields to clear. */
export function setImageProviders(patch: Partial<ImageProviders>): void {
  current = { ...current, ...patch };
}

export function resetImageProviders(): void {
  current = { ...none };
}
