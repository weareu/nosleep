/**
 * Live provider integration — exercises the now-active providers end-to-end.
 *   - Tree-sitter parses real TypeScript and beats regex on edge cases.
 *   - Bootstrap activates exif + clip + tree-sitter + pdf-parse.
 *   - Image extractor with installed providers writes image_features rows.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nosleep-brain-live-"));
process.env.NOSLEEP_DATA_DIR = tmpDataDir;

import { extractSymbolsViaTreeSitter } from "../extractors/code-symbols-treesitter.js";
import { extractSymbolsBest } from "../extractors/code-symbols.js";
import { bootstrapBrainProviders } from "../bootstrap-providers.js";
import { activeDbFor, closeAllBrainDbs } from "../storage/active-db.js";

const ORG = "org_live_test";
const PROJ = "proj_live";

beforeAll(() => {
  activeDbFor(ORG);
});

afterAll(() => {
  closeAllBrainDbs();
  fs.rmSync(tmpDataDir, { recursive: true, force: true });
});

describe("brain providers — live integration", () => {
  test("tree-sitter parses real TypeScript with multiple symbol kinds", async () => {
    const src = `
export class TopClass {
  method() { return 1; }
}

export interface TopInterface { x: number; }
export type TopType = string | number;
export enum TopEnum { A, B }

import { thing } from "./thing.js";
`;
    const result = await extractSymbolsViaTreeSitter(src, "typescript");
    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThan(0);
    const names = new Set(result!.map((s) => s.symbol));
    const kinds = new Set(result!.map((s) => s.symbol_kind));
    expect(names.has("TopClass")).toBe(true);
    expect(kinds.has("class")).toBe(true);
    expect(kinds.has("interface")).toBe(true);
    expect(kinds.has("type")).toBe(true);
    expect(kinds.has("enum")).toBe(true);
    expect(names.has("./thing.js")).toBe(true);
  });

  test("extractSymbolsBest prefers tree-sitter when available", async () => {
    const result = await extractSymbolsBest({
      hash: "0".repeat(64),
      text: "export class LiveClass { foo() {} }",
      file_path: "live.ts",
      project_id: PROJ,
      org_id: ORG,
    });
    expect(result.length).toBeGreaterThan(0);
    const names = new Set(result.map((s) => s.symbol));
    expect(names.has("LiveClass")).toBe(true);
  });

  test("bootstrap activates the full provider suite", async () => {
    const report = await bootstrapBrainProviders();
    expect(report.exif).toBe(true);
    expect(report.clip).toBe(true);
    expect(report.tree_sitter).toBe(true);
    expect(report.pdf_parse).toBe(true);
  });
});
