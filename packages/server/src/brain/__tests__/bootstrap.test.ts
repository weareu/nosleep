/**
 * Bootstrap probe test — confirms the now-installed optional deps actually
 * activate at boot. With deps installed, exif/clip/tree-sitter/pdf-parse
 * should report `true`. claude_vision depends on a `claude` CLI in PATH at
 * test time, which may or may not be present, so we just assert no throw.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-brain-boot-"));
process.env.NOSLEEP_DATA_DIR = tmpDataDir;

import { bootstrapBrainProviders } from "../bootstrap-providers.js";
import { isExifrAvailable } from "../extractors/exif-provider-exifr.js";
import { isTransformersAvailable } from "../extractors/clip-provider-transformers.js";
import { isTreeSitterAvailable } from "../extractors/code-symbols-treesitter.js";
import { isPdfParseAvailable } from "../extractors/pdf-handler.js";
import { activeDbFor, closeAllBrainDbs } from "../storage/active-db.js";

beforeAll(() => {
  activeDbFor("org_boot_test");
});

afterAll(() => {
  closeAllBrainDbs();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("brain provider bootstrap", () => {
  test("deps are installed", async () => {
    const exif = await isExifrAvailable();
    const transformers = await isTransformersAvailable();
    const treeSitter = await isTreeSitterAvailable();
    const pdfParse = await isPdfParseAvailable();

    expect(exif).toBe(true);
    expect(transformers).toBe(true);
    expect(treeSitter).toBe(true);
    expect(pdfParse).toBe(true);
  });

  test("bootstrapBrainProviders activates installed providers", async () => {
    const report = await bootstrapBrainProviders();
    expect(report.exif).toBe(true);
    expect(report.clip).toBe(true);
    expect(report.tree_sitter).toBe(true);
    expect(report.pdf_parse).toBe(true);
    // claude_vision is environmental — accept either.
    expect(typeof report.claude_vision).toBe("boolean");
  });
});
